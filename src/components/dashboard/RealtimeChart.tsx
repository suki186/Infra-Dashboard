'use client'

import { memo, useCallback, useEffect, useRef } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
} from 'chart.js'
import { supabase } from '@/src/utils/supabase'
import type { ServerMetric } from '@/src/config/infrastructure'
import { SERVER_STYLES, SERVER_IDS } from '@/src/config/infrastructure'
import { useMetricsHistory, type HistoryPoint } from '@/src/hooks/useMetricsHistory'
import { useRealtimeStore, type RealtimeSlot } from '@/src/store/useRealtimeStore'
import { PAINT_MS, CHART_OPTIONS, makeInitialDatasets } from './RealtimeChart.config'

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
)

// ─── Mock 모드 ────────────────────────────────────────────────────────────────
const MOCK_MODE        = false
const MOCK_INTERVAL_MS = 30

// 슬롯 1개당 렌더링 폭(px). 이 값이 scrollWidth를 결정한다.
const PX_PER_SLOT = 40

const MOCK_SERVERS = [
  { id: 'kr-seoul-web-01', cpu_base: 45, phase: 0 },
  { id: 'kr-seoul-db-01',  cpu_base: 62, phase: Math.PI / 3 },
  { id: 'kr-jeju-ai-01',   cpu_base: 76, phase: (Math.PI * 2) / 3 },
] as const

function generateMockMetric(
  id: string, cpu_base: number, phase: number, nowMs: number,
): ServerMetric {
  const t      = nowMs / 1000
  const TWO_PI = 2 * Math.PI
  const cpu    = Math.min(100, Math.max(0,
    cpu_base
    + 18 * Math.sin(t * TWO_PI / 300 + phase)
    +  6 * Math.cos(t * TWO_PI / 60  + phase)
    + Math.random() * 5,
  ))
  return {
    server_id:    id,
    status:       'ONLINE',
    cpu_usage:    parseFloat(cpu.toFixed(1)),
    memory_usage: 0,
    disk_io:      0,
  }
}

// ─── 병합 타입 ───────────────────────────────────────────────────────────────
// 페인트 타이머가 읽는 최종 슬롯 — CPU만 필요하므로 최소 필드로 정의.

type CombinedSlot = {
  timestamp: string
  servers:   Record<string, { cpu_usage: number }>
}

// ─── combinedData 계산 함수 (컴포넌트 외부 — 렌더링과 무관) ─────────────────
// 과거(allMetrics, newest→oldest) + 실시간(Zustand slots, oldest→newest)을
// Map으로 O(n) 중복 제거 후 oldest→newest 정렬하여 반환.
// 동일 타임스탬프 충돌 시 실시간 데이터가 과거 데이터를 덮어쓴다.

function computeCombined(
  historical: HistoryPoint[],
  realtime:   RealtimeSlot[],
): CombinedSlot[] {
  const map = new Map<string, CombinedSlot>()

  // 1) 과거 데이터 삽입 (실시간이 나중에 덮어쓸 수 있도록 먼저 삽입)
  for (const p of historical) {
    const servers: Record<string, { cpu_usage: number }> = {}
    for (const [id, snap] of Object.entries(p.servers)) {
      servers[id] = { cpu_usage: snap.cpu_usage }
    }
    map.set(p.timestamp, { timestamp: p.timestamp, servers })
  }

  // 2) 실시간 데이터 삽입 — 같은 타임스탬프면 실시간 우선(override)
  for (const s of realtime) {
    const servers: Record<string, { cpu_usage: number }> = {}
    for (const [id, snap] of Object.entries(s.servers)) {
      servers[id] = { cpu_usage: snap.cpu_usage }
    }
    map.set(s.timestamp, { timestamp: s.timestamp, servers })
  }

  // 3) oldest → newest 정렬 후 반환
  return Array.from(map.values()).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  )
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
const RealtimeChart = memo(function RealtimeChart() {
  const {
    allMetrics,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMetricsHistory({ limit: 50 })

  // ── ref 선언 ────────────────────────────────────────────────────────────────
  const canvasRef          = useRef<HTMLCanvasElement>(null)
  const chartRef           = useRef<ChartJS | null>(null)
  const overlayRef         = useRef<HTMLDivElement>(null)
  const loadingRef         = useRef<HTMLDivElement>(null)
  const scrollerRef        = useRef<HTMLDivElement>(null)
  const chartWrapperRef    = useRef<HTMLDivElement>(null)
  const sentinelRef        = useRef<HTMLDivElement>(null)
  const isViewingHistoryRef    = useRef(false)
  const isComponentFetchingRef = useRef(false)

  // 두 데이터 소스의 최신 값을 항상 보유하는 미러 ref
  // → Zustand subscribe 콜백 · allMetrics effect 양쪽에서 동기적으로 읽고 쓴다.
  const allMetricsRef    = useRef<HistoryPoint[]>([])
  const realtimeSlotsRef = useRef<RealtimeSlot[]>([])

  // 병합·중복제거·정렬이 완료된 최종 배열 — 페인트 타이머가 이것만 읽는다.
  const combinedDataRef  = useRef<CombinedSlot[]>([])

  // ─── 데이터 소스: Supabase 구독 또는 Mock 루프 ──────────────────────────
  // addDataToBuffer 대신 Zustand ingest() 호출.
  // getState()로 읽어 effect deps에 함수 참조를 포함하지 않는다.
  useEffect(() => {
    const { ingest } = useRealtimeStore.getState()

    if (MOCK_MODE) {
      const timer = setInterval(() => {
        const nowMs = Date.now()
        for (const { id, cpu_base, phase } of MOCK_SERVERS) {
          ingest(generateMockMetric(id, cpu_base, phase, nowMs))
        }
      }, MOCK_INTERVAL_MS)
      return () => clearInterval(timer)
    }

    const channel = supabase
      .channel('realtime_chart_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'infrastructure_metrics' },
        (payload) => {
          const row = payload.new as ServerMetric
          if (!SERVER_STYLES[row.server_id]) return
          ingest(row)
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // ─── Zustand 구독 — 리렌더링 없이 실시간 슬롯 미러링 ───────────────────
  // useRealtimeStore() React hook 대신 subscribe()를 사용해
  // 초당 수십 회 발생하는 ingest 업데이트가 리렌더를 유발하지 않도록 한다.
  useEffect(() => {
    // 마운트 시 현재 상태 즉시 동기화
    realtimeSlotsRef.current = useRealtimeStore.getState().slots
    combinedDataRef.current  = computeCombined(allMetricsRef.current, realtimeSlotsRef.current)

    const unsubscribe = useRealtimeStore.subscribe((state) => {
      realtimeSlotsRef.current = state.slots
      // 실시간 슬롯이 바뀔 때마다 combinedData 재계산
      combinedDataRef.current  = computeCombined(allMetricsRef.current, realtimeSlotsRef.current)
    })
    return unsubscribe
  }, [])

  // ─── allMetrics 변경 → allMetricsRef 갱신 + combinedData 재계산 + 스크롤 보존
  useEffect(() => {
    if (allMetrics.length === 0) return

    const scroller        = scrollerRef.current
    const prevCount       = combinedDataRef.current.length
    const savedScroll     = scroller?.scrollLeft  ?? 0
    const prevScrollWidth = scroller?.scrollWidth ?? 0

    // 두 미러 ref를 갱신한 뒤 병합 결과를 한 번만 계산
    allMetricsRef.current   = allMetrics
    combinedDataRef.current = computeCombined(allMetrics, realtimeSlotsRef.current)

    const addedLen = combinedDataRef.current.length - prevCount
    if (addedLen <= 0 || !scroller) {
      isComponentFetchingRef.current = false
      return
    }

    // 타이밍 3단 방어:
    //   1) setTimeout(PAINT_MS): 페인트 타이머가 wrapper 폭을 늘린 뒤
    //   2) rAF ×1: Chart.js ResizeObserver + canvas 재드로 완료 대기
    //   3) rAF ×2: 브라우저 레이아웃·scrollWidth 확정 대기
    setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scroller) return
          const delta = scroller.scrollWidth - prevScrollWidth
          scroller.scrollLeft = Math.max(0, savedScroll + delta)
          isComponentFetchingRef.current = false  // 정상 경로 락 해제
        })
      })
    }, PAINT_MS)
  }, [allMetrics])

  // ─── 로딩 인디케이터 DOM 직접 제어 (리렌더링 없이) ───────────────────────
  useEffect(() => {
    if (loadingRef.current) {
      loadingRef.current.style.display = isFetchingNextPage ? 'flex' : 'none'
    }
    if (!isFetchingNextPage) {
      // 오류·취소 경로 락 해제 안전망 (PAINT_MS × 2 > 정상 경로 330ms)
      const t = setTimeout(() => {
        isComponentFetchingRef.current = false
      }, PAINT_MS * 2)
      return () => clearTimeout(t)
    }
  }, [isFetchingNextPage])

  // ─── IntersectionObserver: 왼쪽 sentinel → fetchNextPage 호출 ─────────
  useEffect(() => {
    const sentinel = sentinelRef.current
    const scroller  = scrollerRef.current
    if (!sentinel || !scroller) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        if (!hasNextPage) return
        if (isFetchingNextPage || isComponentFetchingRef.current) return
        isComponentFetchingRef.current = true
        fetchNextPage()
      },
      { root: scroller, threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // ─── 스크롤 위치 추적 → 실시간 자동 우측 핀 여부 결정 ─────────────────
  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    isViewingHistoryRef.current =
      el.scrollWidth - el.scrollLeft - el.clientWidth > PX_PER_SLOT
  }, [])

  // ─── Chart.js 인스턴스 초기화 (마운트 1회) ──────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return
    chartRef.current = new ChartJS(canvasRef.current, {
      type: 'line',
      data: { labels: [], datasets: makeInitialDatasets() },
      options: CHART_OPTIONS,
    })
    return () => { chartRef.current?.destroy(); chartRef.current = null }
  }, [])

  // ─── 독립 페인트 타이머 (300ms) ─────────────────────────────────────────
  // combinedDataRef만 읽는다 — setState/리렌더 0회.
  // ISO 타임스탬프 → HH:MM:SS 변환은 여기서만 수행.
  useEffect(() => {
    const timer = setInterval(() => {
      const chart = chartRef.current
      if (!chart) return

      const combined = combinedDataRef.current
      if (combined.length === 0) return

      const len = combined.length

      // 캔버스 래퍼 폭 업데이트 (Chart.js responsive 추종)
      const wrapper  = chartWrapperRef.current
      const scroller = scrollerRef.current
      if (wrapper && scroller) {
        const desired = Math.max(len * PX_PER_SLOT, scroller.clientWidth)
        wrapper.style.width = `${desired}px`
      }

      overlayRef.current?.style.setProperty('display', 'none')
      canvasRef.current?.classList.remove('invisible')

      const labels   = chart.data.labels as string[]
      const datasets = chart.data.datasets

      labels.length = len
      datasets.forEach(ds => { (ds.data as (number | null)[]).length = len })

      for (let i = 0; i < len; i++) {
        // ISO → HH:MM:SS (UTC) — Chart.js X축 레이블
        labels[i] = combined[i].timestamp.slice(11, 19)
        SERVER_IDS.forEach((id, j) => {
          (datasets[j].data as (number | null)[])[i] =
            combined[i].servers[id]?.cpu_usage ?? null
        })
      }

      // CPU 90% 임계점 색상 트리거 — 최신 슬롯만 검사
      const latest = combined[len - 1]
      SERVER_IDS.forEach((id, j) => {
        const cpu = latest.servers[id]?.cpu_usage ?? 0
        const ds  = datasets[j]
        if (cpu >= 90) {
          ds.borderColor     = 'rgb(239, 68, 68)'
          ds.backgroundColor = 'rgba(239, 68, 68, 0.08)'
        } else {
          const { color } = SERVER_STYLES[id]
          ds.borderColor     = color
          ds.backgroundColor = color.replace('rgb(', 'rgba(').replace(')', ', 0.08)')
        }
      })

      chart.update('none')

      // 실시간 모드: 최신(우측) 데이터 고정
      if (!isViewingHistoryRef.current && scroller) {
        scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth
      }
    }, PAINT_MS)

    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex flex-col w-full h-full min-h-0 gap-2">

      {/* ① 정적 HTML 범례 — 스크롤 컨테이너 완전 외부, 항상 고정 */}
      <div className="shrink-0 flex items-center gap-5 px-1">
        {SERVER_IDS.map(id => {
          const { label, color } = SERVER_STYLES[id]
          return (
            <div key={id} className="flex items-center gap-1.5">
              <span
                className="w-3 h-3 rounded-sm shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-xs text-slate-300">{label}</span>
            </div>
          )
        })}
      </div>

      {/* ② 차트 영역 */}
      <div className="relative flex-1 min-h-0">

        <div
          ref={overlayRef}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none"
        >
          <span className="text-slate-600 text-2xl">📡</span>
          <p className="text-slate-600 text-sm">시뮬레이터를 실행하면 차트가 표시됩니다</p>
          <p className="text-slate-700 text-xs font-mono">node scripts/simulator.mjs</p>
        </div>

        <div
          ref={loadingRef}
          className="absolute top-0 left-0 z-20 items-center gap-1.5 px-2 py-0.5 rounded-br
                     bg-slate-900/80 border-r border-b border-slate-700 hidden"
        >
          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping shrink-0" />
          <span className="text-[10px] text-blue-400/80 font-mono whitespace-nowrap">
            과거 데이터 로딩 중…
          </span>
        </div>

        <div
          ref={scrollerRef}
          className="w-full h-full overflow-x-auto"
          style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 transparent' }}
          onScroll={handleScroll}
        >
          <div
            ref={chartWrapperRef}
            style={{ minWidth: '100%', height: '100%', position: 'relative' }}
          >
            <div
              ref={sentinelRef}
              className="absolute left-0 top-0 w-px h-full pointer-events-none"
            />
            <canvas ref={canvasRef} className="w-full h-full block invisible" />
          </div>
        </div>

      </div>
    </div>
  )
})

export default RealtimeChart

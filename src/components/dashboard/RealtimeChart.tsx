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
import { useMetricsBuffer } from '@/src/hooks/useMetricsBuffer'
import { useMetricsHistory, type HistoryPoint } from '@/src/hooks/useMetricsHistory'
import { PAINT_MS, CHART_OPTIONS, makeInitialDatasets } from './RealtimeChart.config'
import type { TimeSlot } from '@/src/types/metrics'

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

// HistoryPoint → TimeSlot 변환 (CPU 값만 추출, 실시간 버퍼 포맷과 통일)
function toTimeSlot(point: HistoryPoint): TimeSlot {
  const time   = new Date(point.timestamp).toISOString().slice(11, 19)  // HH:MM:SS (UTC)
  const values: Record<string, number> = {}
  for (const [id, snap] of Object.entries(point.servers)) {
    values[id] = snap.cpu_usage
  }
  return { time, values }
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
const RealtimeChart = memo(function RealtimeChart() {
  const { addDataToBuffer, sharedBufferRef } = useMetricsBuffer()
  const {
    allMetrics,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMetricsHistory({ limit: 50 })

  const canvasRef          = useRef<HTMLCanvasElement>(null)
  const chartRef           = useRef<ChartJS | null>(null)
  const overlayRef         = useRef<HTMLDivElement>(null)
  const loadingRef         = useRef<HTMLDivElement>(null)  // 좌측 로딩 인디케이터
  const scrollerRef        = useRef<HTMLDivElement>(null)  // overflow-x: auto 컨테이너
  const chartWrapperRef    = useRef<HTMLDivElement>(null)  // 폭을 직접 조작할 내부 래퍼
  const sentinelRef        = useRef<HTMLDivElement>(null)  // IntersectionObserver 트리거
  const historicalSlotsRef     = useRef<TimeSlot[]>([])   // 과거 슬롯 (oldest→newest)
  // 유저가 스크롤로 과거를 탐색 중인지 여부 — false면 페인트 타이머가 우측 고정
  const isViewingHistoryRef    = useRef(false)
  // 페치 중 동기 락: React 상태(isFetchingNextPage)가 반영되기 전 갭을 메워
  // Observer 중복 발화로 인한 무한 요청 루프를 원천 차단한다.
  const isComponentFetchingRef = useRef(false)

  // ─── 데이터 소스 (MOCK_MODE로 전환) ─────────────────────────────────────
  useEffect(() => {
    if (MOCK_MODE) {
      const timer = setInterval(() => {
        const nowMs = Date.now()
        for (const { id, cpu_base, phase } of MOCK_SERVERS) {
          addDataToBuffer(generateMockMetric(id, cpu_base, phase, nowMs))
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
          addDataToBuffer(row)
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [addDataToBuffer])

  // ─── allMetrics → historicalSlotsRef 동기화 + 스크롤 보존 ─────────────
  useEffect(() => {
    if (allMetrics.length === 0) return

    const scroller        = scrollerRef.current
    const prevLen         = historicalSlotsRef.current.length
    const savedScroll     = scroller?.scrollLeft    ?? 0
    const prevScrollWidth = scroller?.scrollWidth   ?? 0  // 갱신 전 실제 너비 스냅샷

    // allMetrics: newest→oldest → 뒤집어서 oldest→newest
    historicalSlotsRef.current = [...allMetrics].reverse().map(toTimeSlot)

    const addedLen = historicalSlotsRef.current.length - prevLen
    if (addedLen <= 0 || !scroller) {
      // 데이터가 실제로 늘지 않으면 스크롤 복원 불필요 → 락 즉시 해제
      isComponentFetchingRef.current = false
      return
    }

    // 타이밍 3단 방어:
    //   1) setTimeout(PAINT_MS): 페인트 타이머가 chartWrapperRef.style.width를 늘릴 때까지 대기
    //   2) rAF ×1: Chart.js ResizeObserver → canvas 재드로 처리 대기
    //   3) rAF ×2: 브라우저 레이아웃·scrollWidth 갱신 확정 대기
    // PX_PER_SLOT 추정값 대신 실제 scrollWidth 델타를 사용해 좌표 오차 제거.
    setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scroller) return
          const delta = scroller.scrollWidth - prevScrollWidth
          scroller.scrollLeft = Math.max(0, savedScroll + delta)
          // 스크롤 복원이 DOM에 정착한 이 시점에 락 해제 — 정상 경로
          isComponentFetchingRef.current = false
        })
      })
    }, PAINT_MS)
  }, [allMetrics])

  // ─── 로딩 인디케이터 DOM 직접 제어 (리렌더링 없이) ───────────────────────
  // isFetchingNextPage 변화를 ref.style로만 반영 — memo 리렌더 방어
  useEffect(() => {
    if (loadingRef.current) {
      loadingRef.current.style.display = isFetchingNextPage ? 'flex' : 'none'
    }

    if (!isFetchingNextPage) {
      // 안전망: 네트워크 오류·취소 등으로 allMetrics가 갱신되지 않아
      // 정상 경로(rAF 2차)의 락 해제가 실행되지 않을 때를 대비한 폴백.
      // PAINT_MS × 2 대기로 정상 경로(~PAINT_MS + 2rAF ≈ 330ms)보다 늦게 실행되어
      // 중복 해제가 발생해도 무해하다.
      const t = setTimeout(() => {
        isComponentFetchingRef.current = false
      }, PAINT_MS * 2)
      return () => clearTimeout(t)
    }
  }, [isFetchingNextPage])

  // ─── IntersectionObserver: 왼쪽 sentinel → fetchNextPage 호출 ─────────
  // hasNextPage · isFetchingNextPage 변화마다 observer 재등록
  useEffect(() => {
    const sentinel = sentinelRef.current
    const scroller  = scrollerRef.current
    if (!sentinel || !scroller) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        if (!hasNextPage) return
        // React 상태(isFetchingNextPage)와 동기 락을 이중으로 검사한다.
        // isFetchingNextPage: React 배치 업데이트 반영 후 안전 가드
        // isComponentFetchingRef: fetchNextPage() 호출 직후 ~ React 상태 반영 전
        //   비동기 갭을 메우는 즉각적 동기 락 — 이 갭에서 무한 루프가 발생했던 원인
        if (isFetchingNextPage || isComponentFetchingRef.current) return

        isComponentFetchingRef.current = true  // 락 획득 (동기, 즉각 반영)
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
    // 우측 끝에서 1슬롯 이상 떨어지면 "과거 탐색 모드"
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
  // setState 호출 없음 → 리렌더링 0회.
  // chartWrapperRef.style.width를 직접 조작해 Chart.js responsive 추종.
  useEffect(() => {
    const timer = setInterval(() => {
      const chart = chartRef.current
      if (!chart) return

      const historical = historicalSlotsRef.current
      const realtime   = sharedBufferRef.current
      if (realtime.length === 0 && historical.length === 0) return

      // 실시간 슬롯의 가장 오래된 시각보다 과거인 히스토리 슬롯만 병합
      // → 두 소스의 시간대 겹침(overlap) 제거, 실시간 데이터 우선
      const mergedHistorical = realtime.length > 0
        ? historical.filter(s => s.time < realtime[0].time)
        : historical
      const merged = [...mergedHistorical, ...realtime]
      const len    = merged.length

      // ── 캔버스 래퍼 폭 업데이트 (Chart.js가 responsive로 추종) ──────────
      const wrapper  = chartWrapperRef.current
      const scroller = scrollerRef.current
      if (wrapper && scroller) {
        const desired = Math.max(len * PX_PER_SLOT, scroller.clientWidth)
        wrapper.style.width = `${desired}px`
      }

      overlayRef.current?.style.setProperty('display', 'none')
      canvasRef.current?.classList.remove('invisible')

      // ── Chart.js 데이터 동기화 ────────────────────────────────────────────
      const labels   = chart.data.labels as string[]
      const datasets = chart.data.datasets

      labels.length = len
      datasets.forEach(ds => { (ds.data as (number | null)[]).length = len })

      for (let i = 0; i < len; i++) {
        labels[i] = merged[i].time
        SERVER_IDS.forEach((id, j) => {
          (datasets[j].data as (number | null)[])[i] = merged[i].values[id] ?? null
        })
      }

      // CPU 90% 임계점 색상 트리거 — 최신 슬롯만 검사
      const latest = merged[len - 1]
      SERVER_IDS.forEach((id, j) => {
        const cpu = latest.values[id] ?? 0
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

      // 실시간 모드(과거 탐색 중 아님)일 때 항상 최신(우측) 데이터 고정
      if (!isViewingHistoryRef.current && scroller) {
        scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth
      }
    }, PAINT_MS)

    return () => clearInterval(timer)
  }, [sharedBufferRef])

  return (
    // flex-col: 범례(shrink-0) + 차트 영역(flex-1)으로 수직 분리
    <div className="flex flex-col w-full h-full min-h-0 gap-2">

      {/* ① 정적 HTML 범례 — 스크롤 컨테이너 완전 외부, 항상 고정 표시 */}
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

      {/* ② 차트 영역 — 범례를 제외한 나머지 높이를 모두 차지 */}
      <div className="relative flex-1 min-h-0">

        {/* 데이터 없음 오버레이 */}
        <div
          ref={overlayRef}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none"
        >
          <span className="text-slate-600 text-2xl">📡</span>
          <p className="text-slate-600 text-sm">시뮬레이터를 실행하면 차트가 표시됩니다</p>
          <p className="text-slate-700 text-xs font-mono">node scripts/simulator.mjs</p>
        </div>

        {/* 과거 로딩 인디케이터 — isFetchingNextPage 변화 시 DOM 직접 on/off */}
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

        {/* 수평 스크롤 컨테이너 */}
        <div
          ref={scrollerRef}
          className="w-full h-full overflow-x-auto"
          style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 transparent' }}
          onScroll={handleScroll}
        >
          {/*
            차트 래퍼: minWidth로 컨테이너를 채우고,
            페인트 타이머가 width를 직접 늘려 Chart.js responsive를 추종시킨다.
          */}
          <div
            ref={chartWrapperRef}
            style={{ minWidth: '100%', height: '100%', position: 'relative' }}
          >
            {/* 왼쪽 끝 sentinel — IntersectionObserver가 이 점을 감시 */}
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

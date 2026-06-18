'use client'

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
  type Scale,
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
// wrapper 폭을 실제 데이터 슬롯보다 항상 이 값만큼 더 확보해
// style.width 갱신과 scrollWidth 읽기 사이의 layout flush 타이밍 문제를 방지.
const EXTRA_MARGIN_SLOTS = 3
// 이 거리(px) 이상 우측 끝에서 멀어져야 "과거 조회 모드"로 전환.
// smooth-scroll 애니메이션 중간 위치에서 오탐하지 않도록 마진 슬롯을 포함해 충분히 설정.
const LIVE_EDGE_PX = PX_PER_SLOT * (EXTRA_MARGIN_SLOTS + 2)

// 고정 Y축 패널 너비(px) — 스크롤 컨테이너 바깥에 배치되어 항상 표시됨
const Y_AXIS_WIDTH = 48

// ─── Y축 동적 스케일링 상수 ───────────────────────────────────────────────────
// 300ms 틱마다 현재값 → 목표값의 25%만큼 보간. 약 4-5 틱(1.2~1.5초)에 실질적으로 수렴.
const SCALE_LERP     = 0.50
// 데이터 스팬의 10% + 최소 5 퍼센트포인트를 상하 여백으로 확보.
const Y_MARGIN_RATIO = 0.10
const Y_MARGIN_MIN   = 5
// Y축 경계를 5의 배수로 내림/올림해 눈금이 깔끔한 값에 고정되도록 한다.
const floorTo5 = (x: number) => Math.floor(x / 5) * 5
const ceilTo5  = (x: number) => Math.ceil(x  / 5) * 5

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

  // ── 서버 필터 상태 ───────────────────────────────────────────────────────────
  // true = 차트에 표시, false = 숨김. setState는 범례 UI 리렌더만 유발하며
  // 페인트 타이머는 ref 미러를 읽어 리렌더 없이 즉시 반영.
  const [visibleServers, setVisibleServers] = useState<Record<string, boolean>>(
    () => Object.fromEntries(SERVER_IDS.map(id => [id, true])),
  )
  const visibleServersRef = useRef(visibleServers)

  const toggleServer = useCallback((id: string) => {
    setVisibleServers(prev => {
      const next = { ...prev, [id]: !prev[id] }
      visibleServersRef.current = next
      return next
    })
  }, [])

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

  // Y축 동적 스케일: LERP 보간 중간값을 틱 간에 보존.
  const yScaleRef     = useRef({ min: 0, max: 100 })
  // 스크롤 컨테이너 바깥에 고정되는 Y축 전용 캔버스
  const yAxisCanvasRef = useRef<HTMLCanvasElement>(null)

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
    // LIVE_EDGE_PX: EXTRA_MARGIN_SLOTS + smooth 애니메이션 여유분을 포함한 임계값.
    // 이 거리 안에 있으면 "최신 끝에 핀된 상태"로 간주해 자동 스크롤을 유지한다.
    isViewingHistoryRef.current =
      el.scrollWidth - el.scrollLeft - el.clientWidth > LIVE_EDGE_PX
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

      // 캔버스 래퍼 폭 업데이트: EXTRA_MARGIN_SLOTS 포함
      // — wrapper가 항상 실제 데이터 슬롯보다 넉넉해서 scrollWidth가 즉시 확정됨.
      const wrapper  = chartWrapperRef.current
      const scroller = scrollerRef.current
      if (wrapper && scroller) {
        const desired = Math.max((len + EXTRA_MARGIN_SLOTS) * PX_PER_SLOT, scroller.clientWidth)
        wrapper.style.width = `${desired}px`
        // style.width 변경 후 offsetWidth를 읽어 레이아웃을 강제 flush.
        // 이 한 줄 없이는 바로 아래 scrollWidth 읽기가 스타일 변경 이전 값을 반환한다.
        void wrapper.offsetWidth
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

      // 서버 필터 상태 (Y축 계산 + 가시성 양쪽에서 사용)
      const visible = visibleServersRef.current

      // ── Y축 동적 스케일 계산 ─────────────────────────────────────────────
      // 현재 표시 중인(visible=true) 서버들의 CPU 값 전수 조사
      let yMin = Infinity
      let yMax = -Infinity
      for (const slot of combined) {
        for (let j = 0; j < SERVER_IDS.length; j++) {
          const sid = SERVER_IDS[j]
          if (!(visible[sid] ?? true)) continue
          const cpu = slot.servers[sid]?.cpu_usage
          if (cpu == null) continue
          if (cpu < yMin) yMin = cpu
          if (cpu > yMax) yMax = cpu
        }
      }
      // 표시 데이터가 전혀 없으면(필터로 전부 끔) 풀 레인지로 리셋
      if (!isFinite(yMin)) { yMin = 0; yMax = 100 }

      // 마진 계산: 스팬의 10% 또는 최소 5 퍼센트포인트 중 큰 값
      const span   = yMax - yMin
      const margin = Math.max(span * Y_MARGIN_RATIO, Y_MARGIN_MIN)
      // 경계를 5의 배수로 정렬해 눈금이 깔끔한 값에 고정
      const tMin = Math.max(0,   floorTo5(yMin - margin))
      const tMax = Math.min(100, ceilTo5(yMax  + margin))

      // LERP 보간: 목표값과의 차이가 0.1 미만이면 스냅, 이상이면 25%씩 수렴
      const ys = yScaleRef.current
      ys.min = Math.abs(tMin - ys.min) < 0.1 ? tMin : ys.min + (tMin - ys.min) * SCALE_LERP
      ys.max = Math.abs(tMax - ys.max) < 0.1 ? tMax : ys.max + (tMax - ys.max) * SCALE_LERP

      // Chart.js Y축 옵션 실시간 업데이트
      const yAxis = chart.options.scales?.['y']
      if (yAxis) {
        yAxis.min = ys.min
        yAxis.max = ys.max
      }

      // 데이터셋 가시성 반영 (chart.update 직전에 호출)
      SERVER_IDS.forEach((id, j) => {
        chart.setDatasetVisibility(j, visible[id] ?? true)
      })

      chart.update('none')

      // ── 고정 Y축 캔버스 렌더링 ─────────────────────────────────────────────
      // chart.scales['y'] 의 틱 좌표를 읽어 스크롤 바깥 고정 캔버스에 직접 그린다.
      // 두 캔버스(메인·Y축)는 같은 flex 컨테이너 안에서 동일한 CSS 높이를 공유하므로
      // getPixelForValue() 가 반환하는 Y 좌표가 그대로 Y축 캔버스 좌표와 일치한다.
      const yCanvas = yAxisCanvasRef.current
      const yScale  = (chart.scales as Record<string, Scale>)['y']
      if (yCanvas && yScale) {
        const dpr = window.devicePixelRatio || 1
        const cw  = yCanvas.clientWidth
        const ch  = yCanvas.clientHeight
        if (yCanvas.width  !== Math.round(cw * dpr) ||
            yCanvas.height !== Math.round(ch * dpr)) {
          yCanvas.width  = Math.round(cw * dpr)
          yCanvas.height = Math.round(ch * dpr)
        }
        const ctx = yCanvas.getContext('2d')
        if (ctx) {
          ctx.save()
          ctx.scale(dpr, dpr)
          ctx.clearRect(0, 0, cw, ch)

          ctx.fillStyle    = '#94a3b8'
          ctx.font         = '12px ui-sans-serif, system-ui, sans-serif'
          ctx.textAlign    = 'right'
          ctx.textBaseline = 'middle'
          for (const tick of yScale.ticks) {
            const y = yScale.getPixelForValue(tick.value)
            ctx.fillText(`${Math.round(tick.value)}%`, cw - 6, y)
          }

          // 차트 플롯 영역 구간에만 우측 경계선 표시
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)'
          ctx.lineWidth   = 1
          ctx.beginPath()
          ctx.moveTo(cw - 0.5, yScale.top)
          ctx.lineTo(cw - 0.5, yScale.bottom)
          ctx.stroke()

          ctx.restore()
        }
      }

      // 실시간 모드: 최신(우측) 데이터 고정 — smooth scroll로 부드럽게 전진
      if (!isViewingHistoryRef.current && scroller) {
        const target = scroller.scrollWidth - scroller.clientWidth
        scroller.scrollTo({ left: target, behavior: 'smooth' })
      }
    }, PAINT_MS)

    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex flex-col w-full h-full min-h-0 gap-2">

      {/* ① 다중 서버 필터 범례 — 스크롤 컨테이너 외부, 항상 고정 */}
      <div className="shrink-0 flex items-center gap-1 px-1">
        {SERVER_IDS.map(id => {
          const { label, color } = SERVER_STYLES[id]
          const isOn = visibleServers[id] ?? true
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggleServer(id)}
              title={isOn ? `${label} 숨기기` : `${label} 표시`}
              className={[
                'flex items-center gap-1.5 px-2 py-0.5 rounded',
                'cursor-pointer select-none transition-all duration-150',
                isOn
                  ? 'bg-slate-800/60 hover:bg-slate-700/60'
                  : 'bg-transparent hover:bg-slate-800/40 opacity-40',
              ].join(' ')}
            >
              <span
                className="w-3 h-3 rounded-sm shrink-0 transition-colors duration-150"
                style={{ backgroundColor: isOn ? color : '#475569' }}
              />
              <span className="text-xs text-slate-300">{label}</span>
            </button>
          )
        })}
      </div>

      {/* ② 차트 영역 */}
      <div className="relative flex-1 min-h-0">

        {/* 초기 오버레이 (데이터 없음) — 전체 영역 커버 */}
        <div
          ref={overlayRef}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none"
        >
          <span className="text-slate-600 text-2xl">📡</span>
          <p className="text-slate-600 text-sm">시뮬레이터를 실행하면 차트가 표시됩니다</p>
          <p className="text-slate-700 text-xs font-mono">node scripts/simulator.mjs</p>
        </div>

        {/* 로딩 인디케이터 — Y축 패널 너비만큼 오른쪽에서 시작 */}
        <div
          ref={loadingRef}
          className="absolute top-0 z-20 items-center gap-1.5 px-2 py-0.5 rounded-br
                     bg-slate-900/80 border-r border-b border-slate-700 hidden"
          style={{ left: Y_AXIS_WIDTH }}
        >
          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping shrink-0" />
          <span className="text-[10px] text-blue-400/80 font-mono whitespace-nowrap">
            과거 데이터 로딩 중…
          </span>
        </div>

        {/* [고정 Y축] + [스크롤 차트] — flex 가로 배치 */}
        <div className="flex w-full h-full">

          {/* 고정 Y축 패널: overflow-x-auto 바깥에 있어 스크롤과 무관하게 항상 표시 */}
          <div className="shrink-0 relative" style={{ width: Y_AXIS_WIDTH }}>
            <canvas ref={yAxisCanvasRef} className="absolute inset-0 block w-full h-full" />
          </div>

          {/* 스크롤 가능한 차트 본체 */}
          <div
            ref={scrollerRef}
            className="flex-1 h-full overflow-x-auto"
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
    </div>
  )
})

export default RealtimeChart

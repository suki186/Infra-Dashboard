'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
  type Scale,
} from 'chart.js'
import { supabase } from '@/src/utils/supabase'
import { SERVER_STYLES, SERVER_IDS } from '@/src/config/infrastructure'
import { useMetricsHistory, type HistoryPoint } from '@/src/hooks/useMetricsHistory'
import { useRealtimeStore, type RealtimeSlot } from '@/src/store/useRealtimeStore'
import { PAINT_MS, CHART_OPTIONS, makeInitialDatasets } from '@/src/components/dashboard/RealtimeChart.config'
import {
  MOCK_MODE, MOCK_INTERVAL_MS, MOCK_SERVERS,
  PX_PER_SLOT, EXTRA_MARGIN_SLOTS, LIVE_EDGE_PX,
  SCALE_LERP, Y_MARGIN_RATIO, Y_MARGIN_MIN,
  floorTo5, ceilTo5,
  generateMockMetric, computeCombined,
  type CombinedSlot,
} from '@/src/components/dashboard/RealtimeChart.utils'

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
)

export function useChartPaint() {
  const {
    allMetrics,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMetricsHistory({ limit: 50 })

  // ── 서버 필터 상태 ───────────────────────────────────────────────────────────
  // setState는 범례 UI 리렌더만 유발하며,
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

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  const canvasRef       = useRef<HTMLCanvasElement>(null)
  const chartRef        = useRef<ChartJS | null>(null)
  const overlayRef      = useRef<HTMLDivElement>(null)
  const loadingRef      = useRef<HTMLDivElement>(null)
  const scrollerRef     = useRef<HTMLDivElement>(null)
  const chartWrapperRef = useRef<HTMLDivElement>(null)
  const sentinelRef     = useRef<HTMLDivElement>(null)
  const yAxisCanvasRef  = useRef<HTMLCanvasElement>(null)

  // ── 내부 상태 refs ────────────────────────────────────────────────────────────
  const isViewingHistoryRef    = useRef(false)
  const isComponentFetchingRef = useRef(false)

  // 두 데이터 소스의 최신 값을 항상 보유하는 미러 ref
  const allMetricsRef    = useRef<HistoryPoint[]>([])
  const realtimeSlotsRef = useRef<RealtimeSlot[]>([])
  // 병합·중복제거·정렬이 완료된 최종 배열 — 페인트 타이머가 이것만 읽는다.
  const combinedDataRef  = useRef<CombinedSlot[]>([])

  // Y축 동적 스케일: LERP 보간 중간값을 틱 간에 보존.
  const yScaleRef = useRef({ min: 0, max: 100 })

  // ─── 데이터 소스: Supabase 구독 또는 Mock 루프 ──────────────────────────────
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
          const row = payload.new as Parameters<typeof ingest>[0]
          if (!SERVER_STYLES[row.server_id]) return
          ingest(row)
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // ─── Zustand 구독 — 리렌더링 없이 실시간 슬롯 미러링 ────────────────────────
  // useRealtimeStore() React hook 대신 subscribe()를 사용해
  // 초당 수십 회 발생하는 ingest 업데이트가 리렌더를 유발하지 않도록 한다.
  useEffect(() => {
    realtimeSlotsRef.current = useRealtimeStore.getState().slots
    combinedDataRef.current  = computeCombined(allMetricsRef.current, realtimeSlotsRef.current)

    const unsubscribe = useRealtimeStore.subscribe((state) => {
      realtimeSlotsRef.current = state.slots
      combinedDataRef.current  = computeCombined(allMetricsRef.current, realtimeSlotsRef.current)
    })
    return unsubscribe
  }, [])

  // ─── allMetrics 변경 → ref 갱신 + combinedData 재계산 + 스크롤 보존 ─────────
  useEffect(() => {
    if (allMetrics.length === 0) return

    const scroller        = scrollerRef.current
    const prevCount       = combinedDataRef.current.length
    const savedScroll     = scroller?.scrollLeft  ?? 0
    const prevScrollWidth = scroller?.scrollWidth ?? 0

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
          isComponentFetchingRef.current = false
        })
      })
    }, PAINT_MS)
  }, [allMetrics])

  // ─── 로딩 인디케이터 DOM 직접 제어 (리렌더링 없이) ───────────────────────────
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

  // ─── IntersectionObserver: 왼쪽 sentinel → fetchNextPage 호출 ──────────────
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

  // ─── 스크롤 위치 추적 → 실시간 자동 우측 핀 여부 결정 ──────────────────────
  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    // LIVE_EDGE_PX 안에 있으면 "최신 끝에 핀된 상태"로 간주해 자동 스크롤을 유지.
    isViewingHistoryRef.current =
      el.scrollWidth - el.scrollLeft - el.clientWidth > LIVE_EDGE_PX
  }, [])

  // ─── Chart.js 인스턴스 초기화 (마운트 1회) ──────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return
    chartRef.current = new ChartJS(canvasRef.current, {
      type: 'line',
      data: { labels: [], datasets: makeInitialDatasets() },
      options: CHART_OPTIONS,
    })
    return () => { chartRef.current?.destroy(); chartRef.current = null }
  }, [])

  // ─── 독립 페인트 타이머 (300ms) ─────────────────────────────────────────────
  // combinedDataRef만 읽는다 — setState/리렌더 0회.
  useEffect(() => {
    const timer = setInterval(() => {
      const chart = chartRef.current
      if (!chart) return

      const combined = combinedDataRef.current
      if (combined.length === 0) return

      const len = combined.length

      // 캔버스 래퍼 폭 업데이트: EXTRA_MARGIN_SLOTS 포함
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

      const visible = visibleServersRef.current

      // ── Y축 동적 스케일 계산 ──────────────────────────────────────────────────
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
      if (!isFinite(yMin)) { yMin = 0; yMax = 100 }

      const span   = yMax - yMin
      const margin = Math.max(span * Y_MARGIN_RATIO, Y_MARGIN_MIN)
      const tMin   = Math.max(0,   floorTo5(yMin - margin))
      const tMax   = Math.min(100, ceilTo5(yMax  + margin))

      // LERP 보간: 목표값과의 차이가 0.1 미만이면 스냅, 이상이면 수렴
      const ys = yScaleRef.current
      ys.min = Math.abs(tMin - ys.min) < 0.1 ? tMin : ys.min + (tMin - ys.min) * SCALE_LERP
      ys.max = Math.abs(tMax - ys.max) < 0.1 ? tMax : ys.max + (tMax - ys.max) * SCALE_LERP

      const yAxis = chart.options.scales?.['y']
      if (yAxis) {
        yAxis.min = ys.min
        yAxis.max = ys.max
      }

      SERVER_IDS.forEach((id, j) => {
        chart.setDatasetVisibility(j, visible[id] ?? true)
      })

      chart.update('none')

      // ── 고정 Y축 캔버스 렌더링 ────────────────────────────────────────────────
      // chart.scales['y'] 의 틱 좌표를 읽어 스크롤 바깥 고정 캔버스에 직접 그린다.
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

  return {
    canvasRef,
    overlayRef,
    loadingRef,
    scrollerRef,
    chartWrapperRef,
    sentinelRef,
    yAxisCanvasRef,
    visibleServers,
    toggleServer,
    handleScroll,
  }
}

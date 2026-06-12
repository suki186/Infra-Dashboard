'use client'

import { memo, useEffect, useRef } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
} from 'chart.js'
import { supabase } from '@/src/utils/supabase'
import type { ServerMetric } from '@/src/config/infrastructure'
import { SERVER_STYLES, SERVER_IDS } from '@/src/config/infrastructure'
import { useMetricsBuffer } from '@/src/hooks/useMetricsBuffer'
import { PAINT_MS, CHART_OPTIONS, makeInitialDatasets } from './RealtimeChart.config'

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
)

// ─── Mock 모드 ────────────────────────────────────────────────────────────────
// true  → 브라우저 내부 30ms 루프, Supabase 웹소켓 완전 우회 (로컬 성능 검증)
// false → Supabase postgres_changes 실시간 구독 (프로덕션 기본값)
const MOCK_MODE        = false
const MOCK_INTERVAL_MS = 30

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

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
// memo: props 없음 → 외부 리렌더링과 완전히 단절. 마운트 후 갱신은 setInterval만.
const RealtimeChart = memo(function RealtimeChart() {
  const { addDataToBuffer, sharedBufferRef } = useMetricsBuffer()
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const chartRef   = useRef<ChartJS | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

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

  // ─── 독립 렌더 타이머 (300ms) ────────────────────────────────────────────
  // sharedBufferRef.current를 직접 읽어 Chart.js 배열을 동기화한다.
  // setState 호출 없음 → 리렌더링 0회. isEmpty 전환도 DOM ref 직접 조작.
  useEffect(() => {
    const timer = setInterval(() => {
      const chart = chartRef.current
      if (!chart) return

      const slots = sharedBufferRef.current
      if (slots.length === 0) return

      overlayRef.current?.style.setProperty('display', 'none')
      canvasRef.current?.classList.remove('invisible')

      const labels   = chart.data.labels as string[]
      const datasets = chart.data.datasets
      const len      = slots.length

      // length 트릭: 배열 객체 재사용, 새 할당 없음 → GC 무영향
      labels.length = len
      datasets.forEach(ds => { (ds.data as (number | null)[]).length = len })

      for (let i = 0; i < len; i++) {
        labels[i] = slots[i].time
        SERVER_IDS.forEach((id, j) => {
          (datasets[j].data as (number | null)[])[i] = slots[i].values[id] ?? null
        })
      }

      chart.update('none')
    }, PAINT_MS)

    return () => clearInterval(timer)
  }, [sharedBufferRef])

  return (
    <div className="relative w-full h-full min-h-0">
      <div
        ref={overlayRef}
        className="absolute inset-0 flex flex-col items-center justify-center gap-2"
      >
        <span className="text-slate-600 text-2xl">📡</span>
        <p className="text-slate-600 text-sm">시뮬레이터를 실행하면 차트가 표시됩니다</p>
        <p className="text-slate-700 text-xs font-mono">node scripts/simulator.mjs</p>
      </div>
      <canvas ref={canvasRef} className="w-full h-full block invisible" />
    </div>
  )
})

export default RealtimeChart

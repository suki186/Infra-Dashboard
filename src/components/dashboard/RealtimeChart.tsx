'use client'

import { memo, useEffect, useRef } from 'react'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  LineController, Title, Tooltip, Legend,
} from 'chart.js'
import type { ChartOptions } from 'chart.js'
import { supabase } from '@/src/utils/supabase'
import type { ServerMetric } from '@/src/config/infrastructure'
import { SERVER_STYLES, SERVER_IDS } from '@/src/config/infrastructure'
import { useMetricsBuffer } from '@/src/hooks/useMetricsBuffer'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, LineController, Title, Tooltip, Legend)

const PAINT_MS = 300

const CHART_OPTIONS: ChartOptions<'line'> = {
  responsive: true, maintainAspectRatio: false, animation: false,
  transitions: { active: { animation: { duration: 0 } } },
  interaction: { mode: 'index', intersect: false },
  scales: {
    x: {
      ticks: { color: '#94a3b8', maxTicksLimit: 10, maxRotation: 0 },
      grid:   { color: 'rgba(148, 163, 184, 0.08)' },
      border: { color: 'rgba(148, 163, 184, 0.2)'  },
    },
    y: {
      min: 0, max: 100,
      ticks: { color: '#94a3b8', callback: (v) => `${v}%`, stepSize: 25 },
      grid:   { color: 'rgba(148, 163, 184, 0.08)' },
      border: { color: 'rgba(148, 163, 184, 0.2)'  },
    },
  },
  plugins: {
    legend: { labels: { color: '#cbd5e1', boxWidth: 12, padding: 20, font: { size: 12 } } },
    tooltip: {
      backgroundColor: 'rgba(15, 23, 42, 0.9)',
      borderColor: 'rgba(148, 163, 184, 0.2)', borderWidth: 1,
      titleColor: '#94a3b8', bodyColor: '#e2e8f0',
      callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)}%` },
    },
  },
}

// ─── 로컬 Mock 설정 ───────────────────────────────────────────────────────────
// Supabase 웹소켓을 우회하고 브라우저 내부에서 30ms 폭탄을 직접 생성한다.
// 검증 완료 후 MOCK_MODE = false 로 되돌리면 Supabase 구독이 즉시 복원된다.
const MOCK_MODE        = true
const MOCK_INTERVAL_MS = 30  // 시뮬레이터와 동일한 30ms 밀도

const MOCK_SERVERS = [
  { id: 'kr-seoul-web-01', cpu_base: 45, phase: 0 },
  { id: 'kr-seoul-db-01',  cpu_base: 62, phase: Math.PI / 3 },
  { id: 'kr-jeju-ai-01',   cpu_base: 76, phase: (Math.PI * 2) / 3 },
] as const

function generateMockMetric(
  id: string, cpu_base: number, phase: number, nowMs: number
): ServerMetric {
  const t      = nowMs / 1000
  const TWO_PI = 2 * Math.PI
  const cpu = Math.min(100, Math.max(0,
    cpu_base
    + 18 * Math.sin(t * TWO_PI / 300 + phase)   // 5분 완만한 파동
    +  6 * Math.cos(t * TWO_PI / 60  + phase)   // 1분 잔파
    + Math.random() * 5                          // 노이즈
  ))
  return {
    server_id:    id,
    status:       'ONLINE',
    cpu_usage:    parseFloat(cpu.toFixed(1)),
    memory_usage: 0,
    disk_io:      0,
  }
}

function makeInitialDatasets() {
  return SERVER_IDS.map(id => {
    const { label, color } = SERVER_STYLES[id]
    return {
      label,
      data:             [] as (number | null)[],
      borderColor:      color,
      backgroundColor:  color.replace('rgb(', 'rgba(').replace(')', ', 0.08)'),
      borderWidth:      2,
      pointRadius:      2,
      pointHoverRadius: 5,
      tension:          0.35,
      spanGaps:         true,
      normalized:       true,
    }
  })
}

// memo: 이 컴포넌트는 props가 없으므로 외부 리렌더링에 의해 절대 깨어나지 않는다.
// 마운트 이후 모든 차트 갱신은 setInterval → 직접 DOM 뮤테이션으로만 이루어진다.
const RealtimeChart = memo(function RealtimeChart() {
  const { addDataToBuffer, sharedBufferRef } = useMetricsBuffer()
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const chartRef   = useRef<ChartJS | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  // ─── 데이터 입수 — MOCK_MODE 플래그로 전환 ───────────────────────────────
  // MOCK_MODE = true : 브라우저 내부 30ms 루프 (Supabase 웹소켓 완전 우회)
  // MOCK_MODE = false: Supabase postgres_changes 실시간 구독 (프로덕션)
  useEffect(() => {
    if (MOCK_MODE) {
      // 로컬 Mock 루프 — 외부 네트워크 지연 0%, 시뮬레이터와 동일한 데이터 형식
      const timer = setInterval(() => {
        const nowMs = Date.now()
        for (const { id, cpu_base, phase } of MOCK_SERVERS) {
          addDataToBuffer(generateMockMetric(id, cpu_base, phase, nowMs))
        }
      }, MOCK_INTERVAL_MS)
      return () => clearInterval(timer)
    }

    // Supabase 실시간 구독 (MOCK_MODE = false 로 복원 시 활성화)
    const channel = supabase
      .channel('realtime_chart_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'infrastructure_metrics' },
        (payload) => {
          const row = payload.new as ServerMetric
          if (!SERVER_STYLES[row.server_id]) return
          addDataToBuffer(row)
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [addDataToBuffer])

  // ─── Chart.js 인스턴스 초기화 (마운트 1회) ────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return
    chartRef.current = new ChartJS(canvasRef.current, {
      type:    'line',
      data:    { labels: [], datasets: makeInitialDatasets() },
      options: CHART_OPTIONS,
    })
    return () => { chartRef.current?.destroy(); chartRef.current = null }
  }, [])

  // ─── 독립 렌더 타이머 ─────────────────────────────────────────────────────
  // React 상태(useState/useReducer) 완전 미사용 — setInterval이 직접 구동.
  // 300ms마다 sharedBufferRef.current를 읽어 Chart.js 내부 배열을 동기화한다.
  // isEmpty 전환도 DOM ref로 직접 처리 → 리렌더링 0회.
  useEffect(() => {
    const timer = setInterval(() => {
      const chart = chartRef.current
      if (!chart) return

      const slots = sharedBufferRef.current
      if (slots.length === 0) return

      // 데이터가 최초 도착하면 오버레이 숨김 + 캔버스 가시화 (setState 없음)
      overlayRef.current?.style.setProperty('display', 'none')
      canvasRef.current?.classList.remove('invisible')

      const labels   = chart.data.labels as string[]
      const datasets = chart.data.datasets
      const len      = slots.length

      // length 트릭: 배열 객체 재사용, 크기만 조정 — 새 할당 없음 → GC 무영향
      labels.length = len
      datasets.forEach(ds => { (ds.data as (number | null)[]).length = len })

      // 정렬·중복제거가 완료된 sharedBufferRef 순서대로 인덱스 뮤테이션
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
      {/* 초기 빈 화면 오버레이 — display:none 으로 제어 (React 상태 미사용) */}
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

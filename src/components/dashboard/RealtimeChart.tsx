'use client'

import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import type { ChartOptions } from 'chart.js'
import { supabase } from '@/src/utils/supabase'
import type { ServerMetric } from '@/src/config/infrastructure'
import { SERVER_STYLES, SERVER_IDS } from '@/src/config/infrastructure'
import { useMetricsBuffer } from '@/src/hooks/useMetricsBuffer'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, LineController, Title, Tooltip, Legend)

// ─── 모듈 레벨 상수 — 렌더링마다 재할당되지 않음 ─────────────────────────────

const CHART_OPTIONS: ChartOptions<'line'> = {
  responsive:          true,
  maintainAspectRatio: false,
  // animation을 완전히 비활성화: 프레임 큐 적체 원천 차단
  animation:           false,
  // 데이터 업데이트 시 transition 없이 즉시 캔버스에 반영
  transitions: {
    active: { animation: { duration: 0 } },
  },
  interaction: {
    mode:      'index',
    intersect: false,
  },
  scales: {
    x: {
      ticks: {
        color:         '#94a3b8',
        maxTicksLimit: 10,
        maxRotation:   0,
      },
      grid:   { color: 'rgba(148, 163, 184, 0.08)' },
      border: { color: 'rgba(148, 163, 184, 0.2)'  },
    },
    y: {
      min: 0,
      max: 100,
      ticks: {
        color:    '#94a3b8',
        callback: (value) => `${value}%`,
        stepSize: 25,
      },
      grid:   { color: 'rgba(148, 163, 184, 0.08)' },
      border: { color: 'rgba(148, 163, 184, 0.2)'  },
    },
  },
  plugins: {
    legend: {
      labels: {
        color:    '#cbd5e1',
        boxWidth: 12,
        padding:  20,
        font:     { size: 12 },
      },
    },
    tooltip: {
      backgroundColor: 'rgba(15, 23, 42, 0.9)',
      borderColor:     'rgba(148, 163, 184, 0.2)',
      borderWidth:     1,
      titleColor:      '#94a3b8',
      bodyColor:       '#e2e8f0',
      callbacks: {
        label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)}%`,
      },
    },
  },
}

// 차트 인스턴스 초기화용 데이터셋 껍데기 생성 (data 배열은 빈 채로 시작)
function makeInitialDatasets() {
  return SERVER_IDS.map(id => {
    const { label, color } = SERVER_STYLES[id]
    return {
      label,
      data:            [] as (number | null)[],
      borderColor:     color,
      backgroundColor: color.replace('rgb(', 'rgba(').replace(')', ', 0.08)'),
      borderWidth:     2,
      pointRadius:     2,
      pointHoverRadius: 5,
      tension:         0.35,
      spanGaps:        true,
      // Chart.js에 데이터가 이미 정렬되어 있음을 알려 내부 정규화 비용 절감
      normalized:      true,
    }
  })
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
// memo: page.tsx가 33회/초 리렌더링해도 props가 없으므로 이 컴포넌트는 차단됨
const RealtimeChart = memo(function RealtimeChart() {
  const { addDataToBuffer, timeSlots } = useMetricsBuffer()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Chart.js 인스턴스를 ref로 보유 — React 렌더링 사이클과 완전히 분리
  const chartRef  = useRef<ChartJS | null>(null)

  // ─── Supabase 실시간 구독 ──────────────────────────────────────────────────
  useEffect(() => {
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

  // ─── Chart.js 인스턴스 초기화 (마운트 1회만 실행) ─────────────────────────
  // canvas는 항상 DOM에 존재 → 인스턴스를 destroy/recreate 하지 않음
  useEffect(() => {
    if (!canvasRef.current) return

    chartRef.current = new ChartJS(canvasRef.current, {
      type:    'line',
      data:    { labels: [], datasets: makeInitialDatasets() },
      options: CHART_OPTIONS,
    })

    return () => {
      chartRef.current?.destroy()
      chartRef.current = null
    }
  }, [])

  // ─── 명령형 차트 업데이트 ─────────────────────────────────────────────────
  // useLayoutEffect: DOM 커밋 직후 동기 실행 → 브라우저 페인트 전에 캔버스 갱신 완료
  // useEffect 비동기 지연 제거 → 300ms 틱마다 누락 없이 즉시 반영
  useLayoutEffect(() => {
    const chart = chartRef.current
    if (!chart || timeSlots.length === 0) return

    chart.data.labels = timeSlots.map(s => s.time)
    SERVER_IDS.forEach((id, i) => {
      chart.data.datasets[i].data = timeSlots.map(s => s.values[id] ?? null)
    })
    chart.update('none')
  }, [timeSlots])

  const isEmpty = timeSlots.length === 0

  return (
    <div className="relative w-full h-full min-h-0">
      {isEmpty && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <span className="text-slate-600 text-2xl">📡</span>
          <p className="text-slate-600 text-sm">
            시뮬레이터를 실행하면 차트가 표시됩니다
          </p>
          <p className="text-slate-700 text-xs font-mono">
            node scripts/simulator.mjs
          </p>
        </div>
      )}
      {/* canvas는 항상 DOM에 존재 — 데이터 없을 때 invisible로 숨기되 크기 유지 */}
      <canvas
        ref={canvasRef}
        className={`w-full h-full block${isEmpty ? ' invisible' : ''}`}
      />
    </div>
  )
})

export default RealtimeChart

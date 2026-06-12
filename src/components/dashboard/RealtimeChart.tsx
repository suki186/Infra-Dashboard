'use client'

import { useEffect } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import type { ChartData, ChartOptions } from 'chart.js'
import { supabase } from '@/src/utils/supabase'
import type { ServerMetric } from '@/src/config/infrastructure'
import { SERVER_STYLES, SERVER_IDS } from '@/src/config/infrastructure'
import { useMetricsBuffer } from '@/src/hooks/useMetricsBuffer'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend)

// ─── 상수 ─────────────────────────────────────────────────────────────────────

// ─── Chart.js 옵션 ─────────────────────────────────────────────────────────────
const chartOptions: ChartOptions<'line'> = {
  responsive:          true,
  maintainAspectRatio: false,
  animation:           false,
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

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
export default function RealtimeChart() {
  const { addDataToBuffer, timeSlots } = useMetricsBuffer()

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

    return () => {
      supabase.removeChannel(channel)
    }
  }, [addDataToBuffer])

  // ─── chart.js 데이터 빌드 ─────────────────────────────────────────────────
  const data: ChartData<'line'> = {
    labels: timeSlots.map(s => s.time),
    datasets: SERVER_IDS.map(id => {
      const style = SERVER_STYLES[id]
      return {
        label:            style.label,
        data:             timeSlots.map(s => s.values[id] ?? null),
        borderColor:      style.color,
        backgroundColor:  style.color.replace('rgb(', 'rgba(').replace(')', ', 0.08)'),
        borderWidth:      2,
        pointRadius:      2,
        pointHoverRadius: 5,
        tension:          0.35,
        spanGaps:         true,
      }
    }),
  }

  const isEmpty = timeSlots.length === 0

  return (
    <div className="relative w-full h-full min-h-0">
      {isEmpty ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <span className="text-slate-600 text-2xl">📡</span>
          <p className="text-slate-600 text-sm">
            시뮬레이터를 실행하면 차트가 표시됩니다
          </p>
          <p className="text-slate-700 text-xs font-mono">
            node scripts/simulator.mjs
          </p>
        </div>
      ) : (
        <Line data={data} options={chartOptions} />
      )}
    </div>
  )
}

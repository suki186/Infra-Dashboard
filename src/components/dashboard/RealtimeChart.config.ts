import type { ChartOptions } from 'chart.js'
import { SERVER_IDS, SERVER_STYLES } from '@/src/config/infrastructure'

export const PAINT_MS = 300

export const CHART_OPTIONS: ChartOptions<'line'> = {
  responsive: true, maintainAspectRatio: false,
  animation: false,
  transitions: { active: { animation: { duration: 0 } } },
  interaction: { mode: 'index', intersect: false },
  scales: {
    x: {
      ticks:  { color: '#94a3b8', maxTicksLimit: 10, maxRotation: 0 },
      grid:   { color: 'rgba(148, 163, 184, 0.08)' },
      border: { color: 'rgba(148, 163, 184, 0.2)'  },
    },
    y: {
      min: 0, max: 100,
      ticks:  { color: '#94a3b8', callback: (v) => `${v}%`, stepSize: 25 },
      grid:   { color: 'rgba(148, 163, 184, 0.08)' },
      border: { color: 'rgba(148, 163, 184, 0.2)'  },
    },
  },
  plugins: {
    // 내장 legend는 canvas 안에 그려지므로 수평 스크롤 시 밀려남.
    // HTML 범례를 스크롤 영역 바깥에 별도 렌더링하고 여기서는 비활성화.
    legend: { display: false },
    tooltip: {
      backgroundColor: 'rgba(15, 23, 42, 0.9)',
      borderColor: 'rgba(148, 163, 184, 0.2)', borderWidth: 1,
      titleColor: '#94a3b8', bodyColor: '#e2e8f0',
      callbacks: {
        label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)}%`,
      },
    },
  },
}

export function makeInitialDatasets() {
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

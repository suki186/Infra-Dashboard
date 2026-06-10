import type { MetricsMap } from '@/src/types/infrastructure'

export function deriveStats(metrics: MetricsMap) {
  const all    = Object.values(metrics)
  const online  = all.filter(m => m.status === 'ONLINE')
  const offline = all.filter(m => m.status === 'OFFLINE')

  const serverCount = all.length === 0 ? '—' : String(online.length)

  const avgCpu =
    online.length === 0
      ? '—'
      : (online.reduce((s, m) => s + m.cpu_usage, 0) / online.length).toFixed(1)

  const maxCpu = online.length > 0 ? Math.max(...online.map(m => m.cpu_usage)) : 0
  const risk =
    all.length === 0      ? { label: '—',    color: 'text-slate-400'   }
    : offline.length > 0  ? { label: '위험',  color: 'text-red-400'     }
    : maxCpu >= 90        ? { label: '위험',  color: 'text-red-400'     }
    : maxCpu >= 70        ? { label: '경고',  color: 'text-amber-400'   }
    :                       { label: '정상',  color: 'text-emerald-400' }

  const alertCount = offline.length + online.filter(m => m.cpu_usage >= 90).length

  return { serverCount, avgCpu, risk, alertCount, onlineCount: online.length }
}

export function systemStatusLabel(risk: { label: string }) {
  if (risk.label === '위험') return { text: '시스템 상태: 위험',   dot: 'text-red-400'    }
  if (risk.label === '경고') return { text: '시스템 상태: 경고',   dot: 'text-amber-400'  }
  if (risk.label === '정상') return { text: '시스템 상태: 정상',   dot: 'text-emerald-400'}
  return                             { text: '시스템 상태: 대기중', dot: 'text-slate-400'  }
}

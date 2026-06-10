// ─── 타입 ─────────────────────────────────────────────────────────────────────
export type ServerMetric = {
  server_id:    string
  status:       string
  cpu_usage:    number
  memory_usage: number
  disk_io:      number
}

export type MetricsMap = Record<string, ServerMetric>

// ─── 서버 스타일 설정 ─────────────────────────────────────────────────────────
export const SERVER_STYLES: Record<string, { label: string; color: string }> = {
  'kr-seoul-web-01': { label: 'Seoul Web', color: 'rgb(96, 165, 250)'  },  // blue-400
  'kr-seoul-db-01':  { label: 'Seoul DB',  color: 'rgb(251, 146, 60)'  },  // orange-400
  'kr-jeju-ai-01':   { label: 'Jeju AI',   color: 'rgb(52, 211, 153)'  },  // emerald-400
}

export const SERVER_IDS = Object.keys(SERVER_STYLES)

import type { ServerMetric } from '@/src/config/infrastructure'
import type { HistoryPoint } from '@/src/hooks/useMetricsHistory'
import type { RealtimeSlot } from '@/src/store/useRealtimeStore'

// ─── 레이아웃 상수 ────────────────────────────────────────────────────────────
export const PX_PER_SLOT        = 40
export const EXTRA_MARGIN_SLOTS = 3
// smooth-scroll 애니메이션 중간 위치 오탐 방지를 위해 마진 슬롯 포함해 충분히 설정.
export const LIVE_EDGE_PX       = PX_PER_SLOT * (EXTRA_MARGIN_SLOTS + 2)
export const Y_AXIS_WIDTH       = 48

// ─── Y축 동적 스케일링 상수 ───────────────────────────────────────────────────
export const SCALE_LERP     = 0.50
export const Y_MARGIN_RATIO = 0.10
export const Y_MARGIN_MIN   = 5

export const floorTo5 = (x: number) => Math.floor(x / 5) * 5
export const ceilTo5  = (x: number) => Math.ceil(x  / 5) * 5

// ─── Mock 모드 ────────────────────────────────────────────────────────────────
export const MOCK_MODE        = false
export const MOCK_INTERVAL_MS = 30

export const MOCK_SERVERS = [
  { id: 'kr-seoul-web-01', cpu_base: 45, phase: 0 },
  { id: 'kr-seoul-db-01',  cpu_base: 62, phase: Math.PI / 3 },
  { id: 'kr-jeju-ai-01',   cpu_base: 76, phase: (Math.PI * 2) / 3 },
] as const

export function generateMockMetric(
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

// ─── 병합 슬롯 타입 ───────────────────────────────────────────────────────────
// 페인트 타이머가 읽는 최종 슬롯 — CPU만 필요하므로 최소 필드로 정의.
export type CombinedSlot = {
  timestamp: string
  servers:   Record<string, { cpu_usage: number }>
}

// 과거(allMetrics, newest→oldest) + 실시간(Zustand slots, oldest→newest)을
// Map으로 O(n) 중복 제거 후 oldest→newest 정렬하여 반환.
// 동일 타임스탬프 충돌 시 실시간 데이터가 과거 데이터를 덮어쓴다.
export function computeCombined(
  historical: HistoryPoint[],
  realtime:   RealtimeSlot[],
): CombinedSlot[] {
  const map = new Map<string, CombinedSlot>()

  for (const p of historical) {
    const servers: Record<string, { cpu_usage: number }> = {}
    for (const [id, snap] of Object.entries(p.servers)) {
      servers[id] = { cpu_usage: snap.cpu_usage }
    }
    map.set(p.timestamp, { timestamp: p.timestamp, servers })
  }

  for (const s of realtime) {
    const servers: Record<string, { cpu_usage: number }> = {}
    for (const [id, snap] of Object.entries(s.servers)) {
      servers[id] = { cpu_usage: snap.cpu_usage }
    }
    map.set(s.timestamp, { timestamp: s.timestamp, servers })
  }

  return Array.from(map.values()).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  )
}

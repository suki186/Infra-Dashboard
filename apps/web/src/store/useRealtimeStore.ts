// ─── useRealtimeStore — 실시간 WebSocket/Supabase 메트릭 Zustand 스토어 ────────
// Supabase Realtime(또는 Mock) 이벤트를 10초 단위 슬롯으로 집계한다.
// RealtimeChart가 subscribe()로 ref에 미러링하여 리렌더링 없이 페인트 타이머에 주입.

import { create } from 'zustand'
import type { ServerMetric } from '@/src/config/infrastructure'

// ─── 공개 타입 ───────────────────────────────────────────────────────────────

export type RealtimeServerSnap = {
  cpu_usage:    number
  memory_usage: number
  disk_io:      number
  status:       string
}

export type RealtimeSlot = {
  timestamp: string                            // ISO 8601, 10초 경계로 floor
  servers:   Record<string, RealtimeServerSnap>
}

// ─── 내부 상수 ───────────────────────────────────────────────────────────────

const MAX_SLOTS = 300   // 50분치 (10초 × 300)
const SLOT_MS   = 10_000

/** 현재 시각을 10초 단위 ISO 타임스탬프로 변환 */
function floorToSlotISO(nowMs: number): string {
  return new Date(Math.floor(nowMs / SLOT_MS) * SLOT_MS).toISOString()
}

// ─── 스토어 ──────────────────────────────────────────────────────────────────

type RealtimeStore = {
  slots:  RealtimeSlot[]
  /** Supabase INSERT 이벤트 1건을 해당 시각 슬롯에 집계 */
  ingest: (metric: ServerMetric) => void
}

export const useRealtimeStore = create<RealtimeStore>()((set) => ({
  slots: [],

  ingest: (metric) =>
    set((prev) => {
      const ts   = floorToSlotISO(Date.now())
      const snap: RealtimeServerSnap = {
        cpu_usage:    metric.cpu_usage,
        memory_usage: metric.memory_usage,
        disk_io:      metric.disk_io,
        status:       metric.status,
      }

      const idx = prev.slots.findIndex(s => s.timestamp === ts)

      if (idx >= 0) {
        // 같은 슬롯 내 서버 데이터 갱신 (불변 업데이트)
        const slots = prev.slots.slice()
        slots[idx]  = {
          timestamp: ts,
          servers:   { ...slots[idx].servers, [metric.server_id]: snap },
        }
        return { slots }
      }

      // 새 슬롯 추가 후 MAX_SLOTS 초과분 앞에서 제거
      const slots = [...prev.slots, { timestamp: ts, servers: { [metric.server_id]: snap } }]
      return { slots: slots.length > MAX_SLOTS ? slots.slice(-MAX_SLOTS) : slots }
    }),
}))

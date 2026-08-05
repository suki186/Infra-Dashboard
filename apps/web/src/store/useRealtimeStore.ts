// ─── useRealtimeStore — 실시간 WebSocket/Supabase 메트릭 Zustand 스토어 ────────
// WebSocket(또는 Mock) 이벤트를 1초 단위 슬롯으로 집계한다.
// apps/server 브로드캐스터가 서버당 ~1초 간격으로 메시지를 보내므로,
// 슬롯 폭을 브로드캐스트 주기와 맞춰야 매 틱마다 새 컬럼이 찍힌다
// (10초로 묶으면 같은 슬롯을 계속 덮어써 차트가 9틱 동안 멈춰있다 한 번에 점프하는 것처럼 보인다).
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
  timestamp: string                            // ISO 8601, 1초 경계로 floor
  servers:   Record<string, RealtimeServerSnap>
}

// ─── 내부 상수 ───────────────────────────────────────────────────────────────

const MAX_SLOTS = 300   // 5분치 (1초 × 300)
const SLOT_MS   = 1_000

/** 현재 시각을 1초 단위 ISO 타임스탬프로 변환 */
function floorToSlotISO(nowMs: number): string {
  return new Date(Math.floor(nowMs / SLOT_MS) * SLOT_MS).toISOString()
}

// ─── 스토어 ──────────────────────────────────────────────────────────────────

type RealtimeStore = {
  slots:  RealtimeSlot[]
  /** WebSocket metrics 메시지 1건을 해당 시각 슬롯에 집계 */
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

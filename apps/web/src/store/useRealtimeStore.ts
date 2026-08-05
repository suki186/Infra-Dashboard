// ─── useRealtimeStore — 실시간 WebSocket 단일 연결 + 공유 상태 Zustand 스토어 ────
// apps/server WebSocket(/ws)에 앱 전체에서 단 하나의 연결만 연다.
// 수신한 메시지(type: 'metrics' | 'log')를 파싱해 아래 세 갈래 상태로 나눠 적재하고,
// page.tsx / LogTerminal / useChartPaint 는 이 스토어를 selector 로 구독해서 쓴다
// (기존에는 컴포넌트 3곳이 각자 useServerSocket()을 호출해 동일 데이터를 3중 수신했다).
//
// metrics(집계 슬롯)는 1초 단위로 floor 한다.
// apps/server 브로드캐스터가 서버당 ~1초 간격으로 메시지를 보내므로,
// 슬롯 폭을 브로드캐스트 주기와 맞춰야 매 틱마다 새 컬럼이 찍힌다
// (10초로 묶으면 같은 슬롯을 계속 덮어써 차트가 9틱 동안 멈춰있다 한 번에 점프하는 것처럼 보인다).
// RealtimeChart(useChartPaint)가 subscribe()로 ref에 미러링하여 리렌더링 없이 페인트 타이머에 주입.

import { create } from 'zustand'
import type { WSMessage, ServerMetric as WireServerMetric } from '@infra-dashboard/shared'
import type { ServerMetric, MetricsMap } from '@/src/config/infrastructure'
import { SERVER_STYLES } from '@/src/config/infrastructure'
import type { LogEntry } from '@/src/types/terminal'

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
export const MAX_LOGS = 100

const DEFAULT_WS_URL   = 'ws://localhost:3001/ws'
const RECONNECT_DELAY_MS = 2000

/** 현재 시각을 1초 단위 ISO 타임스탬프로 변환 */
function floorToSlotISO(nowMs: number): string {
  return new Date(Math.floor(nowMs / SLOT_MS) * SLOT_MS).toISOString()
}

// ─── 스토어 ──────────────────────────────────────────────────────────────────

type RealtimeStore = {
  slots:       RealtimeSlot[]
  metrics:     MetricsMap
  logs:        LogEntry[]
  lastUpdated: string
  /** WebSocket metrics 메시지 1건을 해당 시각 슬롯에 집계 */
  ingest: (metric: ServerMetric) => void
  /** 앱 전체에서 단 한 번만 WebSocket 연결을 연다 (StrictMode 이중 호출에도 안전한 싱글턴) */
  connectSocket: () => void
}

export const useRealtimeStore = create<RealtimeStore>()((set, get) => ({
  slots:       [],
  metrics:     {},
  logs:        [],
  lastUpdated: '—',

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

  connectSocket: () => {
    if (socketStarted) return
    socketStarted = true
    openSocket(set, get)
  },
}))

// ─── WebSocket 연결 (모듈 싱글턴) ──────────────────────────────────────────────
// Zustand 스토어 자체가 모듈 싱글턴이므로, 연결 상태도 모듈 스코프 변수로 관리해
// connectSocket()이 여러 번(예: React StrictMode 이중 렌더링) 호출돼도 실제 소켓은
// 하나만 열리도록 보장한다.

let socketStarted = false
let nextLogId      = 1

function wireMetricToLocal(payload: WireServerMetric): ServerMetric {
  return {
    server_id:    payload.serverId,
    status:       payload.status,
    cpu_usage:    payload.cpuUsage,
    memory_usage: payload.memoryUsage,
    disk_io:      payload.diskIo,
  }
}

function openSocket(
  set: (fn: (prev: RealtimeStore) => Partial<RealtimeStore>) => void,
  get: () => RealtimeStore,
) {
  const url = process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL

  function connect() {
    const socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      console.log('📡 WebSocket 서버 연결 성공!', url)
    })

    socket.addEventListener('message', (event) => {
      let message: WSMessage
      try {
        message = JSON.parse(event.data as string) as WSMessage
      } catch (err) {
        console.error('WebSocket 메시지 파싱 실패:', err)
        return
      }

      if (message.type === 'metrics') {
        const metric = wireMetricToLocal(message.payload)

        set((prev) => ({
          metrics:     { ...prev.metrics, [metric.server_id]: metric },
          lastUpdated: new Date().toLocaleTimeString('ko-KR'),
        }))

        // 차트 집계 슬롯은 SERVER_STYLES에 등록된 서버만 대상으로 한다
        // (기존 useChartPaint의 필터링과 동일한 동작 유지).
        if (SERVER_STYLES[metric.server_id]) {
          get().ingest(metric)
        }
      } else if (message.type === 'log') {
        const payload = message.payload
        const entry: LogEntry = {
          id:         nextLogId++,
          created_at: payload.createdAt,
          server_id:  payload.serverId,
          level:      payload.level,
          message:    payload.message,
        }

        set((prev) => {
          const logs = [...prev.logs, entry]
          if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
          return { logs }
        })
      }
    })

    socket.addEventListener('close', () => {
      setTimeout(connect, RECONNECT_DELAY_MS)
    })

    socket.addEventListener('error', () => {
      socket.close()
    })
  }

  connect()
}

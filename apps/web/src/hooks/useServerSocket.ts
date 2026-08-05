// ─── useServerSocket — apps/server WebSocket(/ws) 구독 훅 ──────────────────────
// Supabase Realtime 채널을 대체한다. 컴포넌트마다 독립적으로 훅을 호출하면
// 컴포넌트별 독립 연결(기존 채널 구독 구조와 동일한 형태)을 유지할 수 있다.

import { useEffect, useRef } from 'react'
import type { WSMessage, ServerMetric, LogEntry } from '@infra-dashboard/shared'

const DEFAULT_WS_URL = 'ws://localhost:3001/ws'
const RECONNECT_DELAY_MS = 2000

export type UseServerSocketOptions = {
  onMetric?: (metric: ServerMetric) => void
  onLog?: (log: LogEntry) => void
  /** false면 연결을 아예 열지 않는다 (예: MOCK_MODE). 기본값 true. */
  enabled?: boolean
}

export function useServerSocket({ onMetric, onLog, enabled = true }: UseServerSocketOptions): void {
  // 콜백을 ref 로 미러링 — effect 재실행(재연결) 없이 항상 최신 콜백을 호출한다.
  const onMetricRef = useRef(onMetric)
  const onLogRef = useRef(onLog)
  useEffect(() => {
    onMetricRef.current = onMetric
    onLogRef.current = onLog
  })

  useEffect(() => {
    if (!enabled) return

    const url = process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    function connect() {
      socket = new WebSocket(url)

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
          onMetricRef.current?.(message.payload)
        } else if (message.type === 'log') {
          onLogRef.current?.(message.payload)
        }
      })

      socket.addEventListener('close', () => {
        if (stopped) return
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      })

      socket.addEventListener('error', () => {
        socket?.close()
      })
    }

    connect()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [enabled])
}

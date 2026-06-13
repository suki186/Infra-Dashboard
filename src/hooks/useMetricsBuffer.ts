import { useCallback, useEffect, useRef } from 'react'
import type { ServerMetric } from '@/src/config/infrastructure'
import type { TimeSlot, MetricsBuffer } from '@/src/types/metrics'

const FLUSH_MS  = 300  // 큐 → 공유 버퍼 플러시 주기
const MAX_SLOTS = 30   // X축 윈도우 크기
const MAX_QUEUE = 300  // 이벤트 큐 상한 (30ms × 3서버 × ~3초치)

export function useMetricsBuffer(): MetricsBuffer {
  const queueRef        = useRef<ServerMetric[]>([])
  const sharedBufferRef = useRef<TimeSlot[]>([])

  // 웹소켓·Mock 이벤트 핸들러에서 호출 — React 렌더링과 완전히 무관
  const addDataToBuffer = useCallback((data: ServerMetric) => {
    if (queueRef.current.length >= MAX_QUEUE) queueRef.current.shift()
    queueRef.current.push(data)
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      const pending = queueRef.current.splice(0)
      if (pending.length === 0) return

      const timeLabel = new Date().toISOString().slice(11, 19)
      const buf       = sharedBufferRef.current

      const idx       = buf.findIndex(s => s.time === timeLabel)
      const base      = idx >= 0 ? buf[idx].values : {}
      const newValues: Record<string, number> = { ...base }
      for (const m of pending) newValues[m.server_id] = m.cpu_usage

      if (idx >= 0) {
        buf[idx] = { time: timeLabel, values: newValues }
      } else {
        buf.push({ time: timeLabel, values: newValues })
        // 신규 슬롯이 삽입될 때만 정렬 — HH:MM:SS 고정 포맷은 사전식 = 시간순
        buf.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
        if (buf.length > MAX_SLOTS) buf.splice(0, buf.length - MAX_SLOTS)
      }
    }, FLUSH_MS)

    return () => clearInterval(timer)
  }, [])

  return { addDataToBuffer, sharedBufferRef }
}

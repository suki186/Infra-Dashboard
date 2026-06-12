import { useCallback, useEffect, useRef } from 'react'
import type { ServerMetric } from '@/src/config/infrastructure'

const FLUSH_MS  = 300
const MAX_SLOTS = 30
const MAX_QUEUE = 300

export type TimeSlot = {
  time:   string
  values: Record<string, number>
}

export type MetricsBuffer = {
  addDataToBuffer: (data: ServerMetric) => void
  sharedBufferRef: { current: TimeSlot[] }
}

export function useMetricsBuffer(): MetricsBuffer {
  const queueRef        = useRef<ServerMetric[]>([])
  const sharedBufferRef = useRef<TimeSlot[]>([])

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

      const idx  = buf.findIndex(s => s.time === timeLabel)
      const base = idx >= 0 ? buf[idx].values : {}
      const newValues: Record<string, number> = { ...base }
      for (const m of pending) newValues[m.server_id] = m.cpu_usage

      if (idx >= 0) {
        // 기존 슬롯 제자리 교체 — 배열 길이·순서 불변
        buf[idx] = { time: timeLabel, values: newValues }
      } else {
        // 신규 슬롯: push → 오름차순 정렬 → 윈도우 슬라이딩
        // 정렬 기준: HH:MM:SS 고정 포맷이므로 사전식 비교 == 시간순
        buf.push({ time: timeLabel, values: newValues })
        buf.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
        if (buf.length > MAX_SLOTS) buf.splice(0, buf.length - MAX_SLOTS)
      }
      // React setState 호출 없음 — 이벤트 루프에 리렌더링 스케줄 전혀 없음
    }, FLUSH_MS)

    return () => clearInterval(timer)
  }, [])

  return { addDataToBuffer, sharedBufferRef }
}

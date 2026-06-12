import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerMetric } from '@/src/config/infrastructure'

const THROTTLE_MS = 300
const MAX_SLOTS   = 30   // 300ms 플러시 단위로 유지할 최대 슬롯 수

export type TimeSlot = {
  time:   string                  // HH:MM:SS (X축 레이블)
  values: Record<string, number>  // server_id → cpu_usage
}

export type MetricsBuffer = {
  addDataToBuffer: (data: ServerMetric) => void
  timeSlots: TimeSlot[]
}

export function useMetricsBuffer(): MetricsBuffer {
  // 렌더링을 유발하지 않는 백그라운드 큐
  const queue = useRef<ServerMetric[]>([])

  // 차트가 실제로 읽는 누적 타임슬롯 — 300ms 주기로만 갱신
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>([])

  const addDataToBuffer = useCallback((data: ServerMetric) => {
    queue.current.push(data)
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      // splice(0): 원소를 새 배열로 꺼내고 queue는 빈 채로 유지 (원자적 취득)
      const pending = queue.current.splice(0)
      if (pending.length === 0) return

      // 플러시 시각을 슬롯 키로 사용 — 같은 300ms 배치는 같은 슬롯에 누적
      const timeLabel = new Date().toISOString().slice(11, 19)

      setTimeSlots(prev => {
        // 기존 슬롯 맵을 복사해 불변성 유지
        const slotMap = new Map<string, Record<string, number>>(
          prev.map(s => [s.time, { ...s.values }])
        )

        // pending 레코드를 현재 시각 슬롯에 병합 (같은 server_id는 최신 값으로 갱신)
        const slot = slotMap.get(timeLabel) ?? {}
        for (const m of pending) {
          slot[m.server_id] = m.cpu_usage
        }
        slotMap.set(timeLabel, slot)

        // Map은 삽입 순서를 보장하므로 정렬 불필요
        const slots = Array.from(slotMap, ([time, values]) => ({ time, values }))

        // 슬라이딩 윈도우: MAX_SLOTS 초과 시 가장 오래된 슬롯부터 제거
        return slots.length > MAX_SLOTS ? slots.slice(slots.length - MAX_SLOTS) : slots
      })
    }, THROTTLE_MS)

    return () => clearInterval(timer)
  }, [])

  return { addDataToBuffer, timeSlots }
}

'use client'

// ─── RealtimeSocketProvider — 앱 최상위 WebSocket 연결 초기화 ───────────────────
// useRealtimeStore.connectSocket()을 마운트 시 1회 호출해 앱 전체에서 단 하나의
// WebSocket 연결만 열도록 한다. connectSocket() 자체가 모듈 싱글턴으로 중복 호출을
// 막지만, StrictMode 이중 렌더링에서 불필요한 재호출조차 피하도록 useRef로도 방어한다.
// UI를 렌더링하지 않는 순수 초기화 컴포넌트.

import { useEffect, useRef } from 'react'
import { useRealtimeStore } from '@/src/store/useRealtimeStore'

export default function RealtimeSocketProvider() {
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    useRealtimeStore.getState().connectSocket()
  }, [])

  return null
}

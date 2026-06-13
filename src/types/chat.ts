// ─── chat.ts — 챗봇 도메인 공유 타입 ─────────────────────────────────────────
// PulseDoctor UI · usePulseDoctor 훅이 공통으로 참조하는 타입 정의.
// React 의존이 있으나 런타임 import 가 없는 순수 타입 파일이다.

import type { KeyboardEvent, RefObject } from 'react'

/** 채팅 말풍선 단위 */
export type Message = {
  id:      string
  role:    'user' | 'assistant'
  content: string
}

/** usePulseDoctor 훅의 공개 반환 인터페이스 */
export type UsePulseDoctorReturn = {
  messages:      Message[]
  inputValue:    string
  setInputValue: (v: string) => void
  isTyping:      boolean
  hasData:       boolean
  scrollRef:     RefObject<HTMLDivElement | null>
  handleSend:    () => void
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
}

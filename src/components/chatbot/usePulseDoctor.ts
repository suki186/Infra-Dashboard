// ─── usePulseDoctor — Pulse Doctor 챗봇 비즈니스 로직 훅 ──────────────────────
// PulseDoctor.tsx 는 이 훅이 반환하는 인터페이스만 소비한다.
// 모든 상태·이펙트·API 통신은 이 파일 안에서만 존재한다.
//
// 성능 격리 원칙:
//   page.tsx 의 1초 metrics 갱신이 PulseDoctor 를 re-render 시켜도,
//   RealtimeChart(memo) 는 props 가 없어 절대 깨어나지 않는다.
//   챗봇 상태 변화는 이 컴포넌트 트리 안에서만 전파된다.

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { MetricsMap } from '@/src/config/infrastructure'
import type { LogTerminalHandle } from '@/src/components/dashboard/LogTerminal'
import { sendChatQuestionApi } from '@/src/services/aiApi'

// ─── 타입 ─────────────────────────────────────────────────────────────────────
export type Message = {
  id:      string
  role:    'user' | 'assistant'
  content: string
}

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

// ─── 훅 ───────────────────────────────────────────────────────────────────────
export function usePulseDoctor(
  metrics:         MetricsMap,
  logTerminalRef?: RefObject<LogTerminalHandle | null>,
): UsePulseDoctorReturn {
  const [messages,   setMessages]   = useState<Message[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isTyping,   setIsTyping]   = useState(false)

  const hasData = Object.keys(metrics).length > 0

  const scrollRef       = useRef<HTMLDivElement>(null)
  const welcomeShownRef = useRef(false)

  // 메시지 추가·타이핑 상태 변경 시 스크롤 하단 고정
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, isTyping])

  // metrics 첫 수신 시 환영 메시지 1회 주입
  useEffect(() => {
    if (!hasData || welcomeShownRef.current) return
    welcomeShownRef.current = true
    setMessages([{
      id:      crypto.randomUUID(),
      role:    'assistant',
      content: `인프라 데이터 스트리밍 연결이 완료되었습니다.\n\n${Object.keys(metrics).length}대 서버의 실시간 모니터링이 시작되었습니다.\n서버 상태에 대해 무엇이든 질문해 보세요.`,
    }])
  }, [hasData]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 전송 핸들러 ─────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = inputValue.trim()
    if (!text || isTyping) return

    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }])
    setInputValue('')
    setIsTyping(true)

    // 전송 시점에 로그 터미널의 최근 10줄을 스냅샷 — ref 읽기이므로 re-render 없음
    const recentLogs = logTerminalRef?.current?.getRecentLogs(10) ?? []

    try {
      const content = await sendChatQuestionApi(text, metrics, recentLogs)
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content }])
    } catch (err) {
      console.error('[usePulseDoctor]', err)
      setMessages(prev => [...prev, {
        id:      crypto.randomUUID(),
        role:    'assistant',
        content: '⚠️ AI 응답을 가져오는 중 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.',
      }])
    } finally {
      setIsTyping(false)
    }
  }

  // 외부 인터페이스는 동기 함수로 노출 — Promise 는 내부에서 소화
  function handleSend() { void sendMessage() }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return { messages, inputValue, setInputValue, isTyping, hasData, scrollRef, handleSend, handleKeyDown }
}

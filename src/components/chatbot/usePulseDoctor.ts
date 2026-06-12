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
export function usePulseDoctor(metrics: MetricsMap): UsePulseDoctorReturn {
  const [messages,   setMessages]   = useState<Message[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isTyping,   setIsTyping]   = useState(false)

  // metrics 수신 여부 — false 일 때 챗봇 전체가 비활성 상태로 전환된다
  const hasData = Object.keys(metrics).length > 0

  const scrollRef       = useRef<HTMLDivElement>(null)
  const welcomeShownRef = useRef(false)

  // 메시지 추가·타이핑 상태 변경 시 스크롤 하단 고정
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, isTyping])

  // metrics 첫 수신 시 환영 메시지 1회 주입
  // hasData 가 false → true 로 전환되는 시점에만 실행되며,
  // 이후 1초 갱신으로는 welcomeShownRef 가드에 의해 재실행되지 않는다
  useEffect(() => {
    if (!hasData || welcomeShownRef.current) return
    welcomeShownRef.current = true
    setMessages([{
      id:      crypto.randomUUID(),
      role:    'assistant',
      content: `인프라 데이터 스트리밍 연결이 완료되었습니다.\n\n${Object.keys(metrics).length}대 서버의 실시간 모니터링이 시작되었습니다.\n서버 상태에 대해 무엇이든 질문해 보세요.`,
    }])
  }, [hasData]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 전송 핸들러 (OpenAI /api/chat 연동) ─────────────────────────────────
  async function sendMessage() {
    const text = inputValue.trim()
    if (!text || isTyping) return

    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }])
    setInputValue('')
    setIsTyping(true)

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, metrics }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: { content?: string; error?: string } = await res.json()
      if (data.error) throw new Error(data.error)

      setMessages(prev => [...prev, {
        id:      crypto.randomUUID(),
        role:    'assistant',
        content: data.content ?? '응답을 받지 못했습니다.',
      }])
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

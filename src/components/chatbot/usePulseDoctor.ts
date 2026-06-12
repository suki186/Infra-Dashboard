// ─── usePulseDoctor — Pulse Doctor 챗봇 비즈니스 로직 훅 ──────────────────────
// PulseDoctor.tsx 는 이 훅이 반환하는 인터페이스만 소비하며,
// 모든 상태·이펙트·핸들러는 이 파일 안에서만 존재한다.
//
// 성능 격리 원칙:
//   page.tsx 의 1초 metrics 갱신이 PulseDoctor 를 re-render 시켜도,
//   RealtimeChart(memo)는 props 가 없어 절대 깨어나지 않는다.
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

// ─── 모의 AI 응답 생성기 ──────────────────────────────────────────────────────
// 전송 시점의 metrics 스냅샷을 받아 진단 문자열을 생성한다.
// 실제 LLM API 연결 시 이 함수를 async API 호출로 교체하면 된다.
function buildMockResponse(metrics: MetricsMap): string {
  const entries = Object.entries(metrics)

  if (entries.length === 0) {
    return '현재 수신된 서버 데이터가 없습니다.\n\n시뮬레이터를 먼저 실행해 주세요.\n`node scripts/simulator.mjs`'
  }

  const danger = entries.filter(([, m]) => m.cpu_usage >= 90)
  const warn   = entries.filter(([, m]) => m.cpu_usage >= 70 && m.cpu_usage < 90)

  if (danger.length > 0) {
    const lines = danger
      .map(([id, m]) => `• [${id}]  CPU ${m.cpu_usage.toFixed(1)}%  /  MEM ${m.memory_usage.toFixed(1)}%`)
      .join('\n')
    return `현재 실시간 메트릭 분석 결과,\n\n${lines}\n\n위 서버의 CPU가 수치상 위험 수준입니다. 즉각적인 부하 분산 및 점검이 권고됩니다.`
  }

  if (warn.length > 0) {
    const lines = warn
      .map(([id, m]) => `• [${id}]  CPU ${m.cpu_usage.toFixed(1)}%  /  MEM ${m.memory_usage.toFixed(1)}%`)
      .join('\n')
    return `경계 수준 서버가 감지되었습니다.\n\n${lines}\n\n현재 수준에서 트래픽 분산 검토를 권장합니다.`
  }

  const avgCpu = (entries.reduce((s, [, m]) => s + m.cpu_usage, 0) / entries.length).toFixed(1)
  const avgMem = (entries.reduce((s, [, m]) => s + m.memory_usage, 0) / entries.length).toFixed(1)
  const lines  = entries
    .map(([id, m]) => `• [${id}]  CPU ${m.cpu_usage.toFixed(1)}%  /  MEM ${m.memory_usage.toFixed(1)}%`)
    .join('\n')
  return `${entries.length}대 서버 모두 정상 운영 중입니다.\n\n${lines}\n\n전체 평균  CPU ${avgCpu}%  /  MEM ${avgMem}%`
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
  // hasData 가 false→true 로 전환되는 시점에만 실행되며, 이후 1초 갱신으로는 재실행되지 않는다
  useEffect(() => {
    if (!hasData || welcomeShownRef.current) return
    welcomeShownRef.current = true
    setMessages([{
      id:      crypto.randomUUID(),
      role:    'assistant',
      content: `인프라 데이터 스트리밍 연결이 완료되었습니다.\n\n${Object.keys(metrics).length}대 서버의 실시간 모니터링이 시작되었습니다.\n서버 상태에 대해 무엇이든 질문해 보세요.`,
    }])
  }, [hasData]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleSend() {
    const text = inputValue.trim()
    if (!text || isTyping) return

    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }])
    setInputValue('')
    setIsTyping(true)

    // 전송 시점의 metrics 스냅샷으로 응답 생성 (클로저 캡처 — 지연 후에도 send 시점 값 유지)
    const response = buildMockResponse(metrics)

    setTimeout(() => {
      setIsTyping(false)
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: response }])
    }, 1_500)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return { messages, inputValue, setInputValue, isTyping, hasData, scrollRef, handleSend, handleKeyDown }
}

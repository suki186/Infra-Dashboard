'use client'

// ─── PulseDoctor — AI 인프라 진단 챗봇 ──────────────────────────────────────
// 이 컴포넌트는 page.tsx의 Supabase 구독 상태(metrics)를 Props로 받아
// 독립적인 채팅 UI를 운용한다.
//
// 성능 격리 원칙:
//   - 차트 파이프라인(setInterval 300ms 직접 드로잉)과 완전히 분리된 자체 상태를 가진다.
//   - 채팅 입력·말풍선 렌더링은 이 컴포넌트 트리 안에서만 일어나며,
//     page.tsx의 1초 metrics 갱신이 이 컴포넌트를 re-render해도
//     차트 컴포넌트(memo)는 절대 깨어나지 않는다.

import { useEffect, useRef, useState } from 'react'
import type { MetricsMap } from '@/src/config/infrastructure'

// ─── 타입 ─────────────────────────────────────────────────────────────────────
type Message = {
  id:      string
  role:    'user' | 'assistant'
  content: string
}

type Props = {
  // page.tsx가 Supabase Realtime으로 상시 갱신하는 최신 서버 메트릭 스냅샷
  metrics: MetricsMap
}

// ─── 모의 AI 응답 생성기 ──────────────────────────────────────────────────────
// 전송 버튼 클릭 시점의 metrics 스냅샷을 캡처하여 진단 문자열을 생성한다.
// 실제 LLM API 연결 시 이 함수를 API 호출로 교체하면 된다.
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

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
export default function PulseDoctor({ metrics }: Props) {
  const [messages,   setMessages]   = useState<Message[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isTyping,   setIsTyping]   = useState(false)

  // metrics 수신 여부 — 이 값이 false일 때 챗봇 전체를 비활성 상태로 전환
  const hasData = Object.keys(metrics).length > 0

  // 메시지 목록 하단 자동 스크롤
  const scrollRef       = useRef<HTMLDivElement>(null)
  const welcomeShownRef = useRef(false)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, isTyping])

  // metrics 첫 수신 시 환영 메시지 1회 주입 — 이후 1초 갱신으로는 재실행되지 않음
  useEffect(() => {
    if (!hasData || welcomeShownRef.current) return
    welcomeShownRef.current = true
    setMessages([{
      id:      crypto.randomUUID(),
      role:    'assistant',
      content: `인프라 데이터 스트리밍 연결이 완료되었습니다.\n\n${Object.keys(metrics).length}대 서버의 실시간 모니터링이 시작되었습니다.\n서버 상태에 대해 무엇이든 질문해 보세요.`,
    }])
  }, [hasData]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 전송 핸들러 ────────────────────────────────────────────────────────────
  function handleSend() {
    const text = inputValue.trim()
    if (!text || isTyping) return

    // 유저 말풍선 즉시 추가
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }])
    setInputValue('')
    setIsTyping(true)

    // 전송 시점의 metrics 스냅샷으로 응답 생성 (클로저 캡처 — 지연 후에도 send 시점 값 유지)
    const response = buildMockResponse(metrics)

    // 타이핑 인디케이터 노출 후 AI 응답 주입
    setTimeout(() => {
      setIsTyping(false)
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: response }])
    }, 1_500)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return (
    <div className="flex flex-col gap-3 min-w-0 w-full lg:flex-[3] rounded-xl bg-slate-800 border border-slate-700 p-4 md:p-5">

      {/* 헤더 */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-base">🤖</span>
        <h2 className="text-sm font-semibold text-slate-100">Pulse Doctor</h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
          <span className={`w-1.5 h-1.5 rounded-full
            ${!hasData  ? 'bg-slate-600'   : 'animate-pulse'}
            ${!hasData  ? ''               : isTyping ? 'bg-yellow-400' : 'bg-emerald-500'}
          `} />
          {!hasData ? '연결 대기' : isTyping ? '분석 중' : '대기 중'}
        </span>
      </div>

      {/* 메시지 영역 */}
      <div
        ref={scrollRef}
        className="flex flex-col gap-3 flex-1 overflow-y-auto min-h-36 lg:min-h-0 py-1 pr-0.5
                   scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent"
      >
        {!hasData ? (
          // ── 연결 대기 — 데이터 미수신 시 스켈레톤·애니메이션 없음 ──────────
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center select-none">
            <span className="text-2xl opacity-30">📡</span>
            <p className="text-xs text-slate-500 leading-relaxed px-3">
              실시간 인프라 데이터 스트리밍이<br />
              연결되면 AI 진단 서비스가 활성화됩니다.
            </p>
          </div>
        ) : (
          // ── 채팅 로그 — 환영 메시지 포함, 이후 대화가 누적됨 ─────────────
          <>
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex gap-2 items-start ${msg.role === 'user' ? 'justify-end' : ''}`}
              >
                {msg.role === 'assistant' && (
                  <div className="w-6 h-6 rounded-full bg-slate-600 border border-slate-500 shrink-0 mt-0.5 flex items-center justify-center text-[10px]">
                    🤖
                  </div>
                )}
                <div className={`
                  max-w-[82%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words
                  ${msg.role === 'user'
                    ? 'bg-blue-600/25 border border-blue-500/30 text-slate-200 rounded-tr-sm'
                    : 'bg-slate-700 border border-slate-600/60 text-slate-200 rounded-tl-sm'
                  }
                `}>
                  {msg.content}
                </div>
              </div>
            ))}

            {/* 타이핑 인디케이터 — isTyping 구간에만 표시 */}
            {isTyping && (
              <div className="flex gap-2 items-center">
                <div className="w-6 h-6 rounded-full bg-slate-600 border border-slate-500 shrink-0 flex items-center justify-center text-[10px]">
                  🤖
                </div>
                <div className="flex items-center gap-1.5 px-3 py-2.5 bg-slate-700 rounded-xl border border-slate-600/60 rounded-tl-sm">
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 입력 필드 */}
      <div className="shrink-0 flex gap-2 items-center">
        <input
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={hasData ? '서버 상태를 질문하세요...' : '데이터 스트리밍 연결 대기 중...'}
          disabled={!hasData || isTyping}
          className="flex-1 h-9 rounded-lg bg-slate-700/60 border border-slate-600 px-3
                     text-xs text-slate-200 placeholder-slate-500
                     focus:outline-none focus:border-slate-400
                     disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
        />
        <button
          onClick={handleSend}
          disabled={!hasData || !inputValue.trim() || isTyping}
          aria-label="전송"
          className="w-9 h-9 rounded-lg bg-blue-600 hover:bg-blue-500
                     disabled:bg-slate-700 disabled:cursor-not-allowed
                     transition-colors flex items-center justify-center shrink-0"
        >
          {/* 전송 아이콘 */}
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>

    </div>
  )
}

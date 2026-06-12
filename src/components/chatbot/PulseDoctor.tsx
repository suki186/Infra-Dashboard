'use client'

import type { MetricsMap } from '@/src/config/infrastructure'
import { usePulseDoctor } from './usePulseDoctor'

type Props = { metrics: MetricsMap }

export default function PulseDoctor({ metrics }: Props) {
  const {
    messages,
    inputValue,
    setInputValue,
    isTyping,
    hasData,
    scrollRef,
    handleSend,
    handleKeyDown,
  } = usePulseDoctor(metrics)

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

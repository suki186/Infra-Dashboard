'use client'

// ─── LogTerminal — 실시간 시스템 로그 터미널 뷰 ───────────────────────────────
// Supabase infrastructure_logs 테이블 INSERT 이벤트를 구독하여
// 리눅스 터미널 감성의 UI로 스트리밍 출력한다.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { supabase } from '@/src/utils/supabase'
import type { LogTerminalHandle, LogLevel, LogEntry } from '@/src/types/terminal'

// ─── 상수 ──────────────────────────────────────────────────────────────────────
const MAX_LOGS = 100

const LEVEL_BADGE: Record<LogLevel, string> = {
  INFO:  'text-emerald-400',
  WARN:  'text-yellow-400',
  ERROR: 'text-red-400',
}

const MSG_COLOR: Record<LogLevel, string> = {
  INFO:  'text-slate-400',
  WARN:  'text-yellow-200/80',
  ERROR: 'text-red-300',
}

const SERVER_COLOR: Record<string, string> = {
  'kr-seoul-web-01': 'text-blue-400',
  'kr-seoul-db-01':  'text-orange-400',
  'kr-jeju-ai-01':   'text-emerald-400',
}

// ─── 헬퍼 ──────────────────────────────────────────────────────────────────────
function formatTimestamp(iso: string): string {
  // '2026-06-13T12:34:56.789Z' → '12:34:56'
  return iso.slice(11, 19)
}

function formatLogLine(e: LogEntry): string {
  const ts = e.created_at.slice(0, 19).replace('T', ' ')
  return `[${ts}] [${e.level}] [${e.server_id}] ${e.message}`
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
export const LogTerminal = forwardRef<LogTerminalHandle, object>(
  function LogTerminal(_, ref) {
    // 로그 데이터 배열 — useState 가 아닌 useRef 로 관리
    // React 조정자를 깨우지 않고 직접 mutation 으로 누적한다.
    const logsRef      = useRef<LogEntry[]>([])
    const scrollRef    = useRef<HTMLDivElement>(null)
    const [tick, setTick] = useState(0)   // 렌더 트리거 전용

    // ─── 외부 핸들 노출 ────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      getRecentLogs: (n = 10) =>
        logsRef.current.slice(-n).map(formatLogLine),

      injectLog: ({ server_id = 'kr-seoul-web-01', level = 'ERROR', message }) => {
        const entry: LogEntry = {
          id:         Date.now(),
          created_at: new Date().toISOString(),
          server_id,
          level,
          message,
        }
        const logs = logsRef.current
        logs.push(entry)
        if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
        setTick(t => t + 1)
      },
    }))

    // ─── Supabase Realtime 구독 ───────────────────────────────────────────
    useEffect(() => {
      const channel = supabase
        .channel('infrastructure_logs_feed')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'infrastructure_logs' },
          ({ new: row }) => {
            const entry = row as LogEntry
            const logs  = logsRef.current
            logs.push(entry)
            // 메모리 보호 — MAX_LOGS 초과분 앞에서 제거
            if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
            setTick(t => t + 1)
          }
        )
        .subscribe()

      return () => { supabase.removeChannel(channel) }
    }, [])

    // ─── 자동 스크롤 — smooth 미사용 (로그 급증 시 janky 방지) ──────────────
    useEffect(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }, [tick])

    const logs = logsRef.current

    return (
      <div className="shrink-0 rounded-xl overflow-hidden border border-slate-700/60 bg-slate-950">

        {/* 터미널 타이틀 바 */}
        <div className="flex items-center gap-3 px-4 py-2 bg-[#1a1f2e] border-b border-slate-700/50 select-none">
          {/* macOS 스타일 윈도우 컨트롤 */}
          <div className="flex gap-1.5 shrink-0">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
          </div>
          <span className="font-mono text-[11px] text-slate-500 truncate">
            <span className="text-emerald-500/80">ops@infra</span>
            <span className="text-slate-600">:</span>
            <span className="text-blue-400/80">~</span>
            <span className="text-slate-500">$ </span>
            <span className="text-slate-400">tail -f /var/log/infrastructure.log</span>
          </span>
          <div className="ml-auto flex items-center gap-3 shrink-0">
            {logs.length > 0 && (
              <span className="font-mono text-[10px] text-slate-600">
                {logs.length}/{MAX_LOGS} lines
              </span>
            )}
            <span className={`w-1.5 h-1.5 rounded-full ${logs.length > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-slate-700'}`} />
          </div>
        </div>

        {/* 로그 바디 */}
        <div
          ref={scrollRef}
          className="h-36 md:h-44 overflow-y-auto px-4 py-2.5 font-mono text-[11px] leading-5 space-y-px"
        >
          {logs.length === 0 ? (
            <span className="text-slate-700">
              waiting for log stream
              <span className="animate-pulse">▋</span>
            </span>
          ) : (
            logs.map(log => (
              <div key={log.id} className="flex gap-2 items-baseline min-w-0">
                {/* 타임스탬프 */}
                <span className="shrink-0 text-slate-700 tabular-nums">
                  {formatTimestamp(log.created_at)}
                </span>
                {/* 레벨 배지 */}
                <span className={`shrink-0 font-bold tabular-nums w-[34px] ${LEVEL_BADGE[log.level] ?? 'text-slate-400'}`}>
                  {log.level}
                </span>
                {/* 서버 ID */}
                <span className={`shrink-0 ${SERVER_COLOR[log.server_id] ?? 'text-sky-400'}`}>
                  [{log.server_id}]
                </span>
                {/* 메시지 */}
                <span className={`truncate ${MSG_COLOR[log.level] ?? 'text-slate-400'}`}>
                  {log.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }
)

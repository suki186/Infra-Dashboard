// ─── terminal.ts — 로그 터미널 도메인 공유 타입 ───────────────────────────────
// LogTerminal 컴포넌트 · usePulseDoctor · page.tsx 가 공통으로 참조하는 타입.
// React / Supabase 런타임 의존 없는 순수 타입 파일이다.

/** LogTerminal 의 forwardRef 핸들 — 외부에서 최근 로그를 읽거나 직접 주입하는 인터페이스 */
export type LogTerminalHandle = {
  /** 마지막 n줄 로그를 '[timestamp] [LEVEL] [server_id] message' 형식으로 반환 */
  getRecentLogs: (n?: number) => string[]
  /** 외부(테스트·장애 주입 버튼)에서 가상 로그 엔트리를 터미널에 직접 삽입 */
  injectLog: (partial: { server_id?: string; level?: LogLevel; message: string }) => void
}

/** 로그 심각도 레벨 */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** Supabase infrastructure_logs 테이블 행 구조 */
export type LogEntry = {
  id:         number
  created_at: string
  server_id:  string
  level:      LogLevel
  message:    string
}

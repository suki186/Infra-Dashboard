// ─── aiApi — AI 챗봇 API 통신 레이어 ─────────────────────────────────────────
// Next.js Route Handler /api/chat 와의 HTTP 통신만 담당한다.
// 상태 관리·React 의존 없음 — 순수 비동기 함수.

import type { MetricsMap } from '@/src/config/infrastructure'

/**
 * Pulse Doctor 챗 질문을 /api/chat 으로 전송하고 AI 응답 문자열을 반환한다.
 *
 * @param text       유저 입력 텍스트
 * @param metrics    현재 서버 메트릭 스냅샷
 * @param recentLogs 로그 터미널의 최근 N줄 (포맷: '[timestamp] [LEVEL] [server] msg')
 *
 * HTTP 오류 또는 API 측 error 필드 수신 시 Error 를 throw 하여
 * 호출부(usePulseDoctor)의 try-catch 가 처리하도록 위임한다.
 */
export async function sendChatQuestionApi(
  text:       string,
  metrics:    MetricsMap,
  recentLogs: string[] = [],
): Promise<string> {
  const res = await fetch('/api/chat', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message: text, metrics, recentLogs }),
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const data: { content?: string; error?: string } = await res.json()
  if (data.error) throw new Error(data.error)

  return data.content ?? '응답을 받지 못했습니다.'
}

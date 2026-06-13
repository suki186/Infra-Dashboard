// ─── POST /api/chat — OpenAI gpt-4o-mini 라우트 핸들러 ───────────────────────
// 요청: { message: string, metrics: MetricsMap, recentLogs?: string[] }
// 응답: { content: string } | { error: string }

import type { MetricsMap } from '@/src/config/infrastructure'

// 두괄식 + <details> 강제 + 로그 기반 진단 능력 시스템 프롬프트
const SYSTEM_PROMPT =
  '당신은 고성능 실시간 인프라 관제탑의 시니어 DevOps AI 아키텍트입니다.\n\n' +

  '【응답 포맷 규칙】\n' +
  '챗봇 가로 폭이 좁으므로, 모든 답변은 반드시 핵심 요약 2~3줄로 두괄식 시작하세요.\n' +
  '구체적인 트러블슈팅 명령어 리스트나 상세 설명은 다음 마크다운 양식으로 감싸서 응답하세요:\n\n' +
  '<details><summary>🛠️ 상세 조치 가이드 및 CLI 명령어 보기</summary>\n\n' +
  '```bash\n# 여기에 실제 명령어\n```\n\n' +
  '</details>\n\n' +

  '【로그 진단 규칙】\n' +
  '유저 메시지에 시스템 로그가 첨부된 경우 아래 순서로 분석하세요:\n' +
  '1. ERROR 레벨 항목을 우선 파싱하여 장애 원인(예: Connection pool exhausted, OOM 등)을 직접 지목하세요.\n' +
  '2. WARN 항목은 선제적 위험 징후로 언급하세요.\n' +
  '3. 타임스탬프와 서버 ID를 함께 인용하여 "언제, 어느 서버에서" 발생했는지 구체적으로 짚으세요.\n' +
  '4. 로그가 없을 경우 메트릭 수치만으로 진단하세요.'

function buildUserMessage(message: string, metrics: MetricsMap, recentLogs: string[]): string {
  const parts: string[] = []

  // 메트릭 스냅샷
  const entries = Object.entries(metrics)
  if (entries.length > 0) {
    const snapshot = entries
      .map(([id, m]) => `• [${id}]  CPU ${m.cpu_usage.toFixed(1)}%  /  MEM ${m.memory_usage.toFixed(1)}%`)
      .join('\n')
    parts.push(`📊 현재 인프라 메트릭 스냅샷:\n${snapshot}`)
  }

  // 실시간 로그 컨텍스트
  if (recentLogs.length > 0) {
    parts.push(`📋 최근 시스템 로그 (마지막 ${recentLogs.length}줄):\n${recentLogs.join('\n')}`)
  }

  parts.push(`❓ 질문: ${message}`)
  return parts.join('\n\n')
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다.' }, { status: 500 })
  }

  let body: { message?: string; metrics?: MetricsMap; recentLogs?: string[] }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '잘못된 요청 형식입니다.' }, { status: 400 })
  }

  const { message, metrics = {}, recentLogs = [] } = body
  if (!message?.trim()) {
    return Response.json({ error: '메시지가 비어있습니다.' }, { status: 400 })
  }

  let openaiRes: Response
  try {
    openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       'gpt-4o-mini',
        messages:    [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: buildUserMessage(message, metrics, recentLogs) },
        ],
        max_tokens:  1000,
        temperature: 0.65,
      }),
    })
  } catch (err) {
    console.error('[/api/chat] fetch 실패:', err)
    return Response.json({ error: 'OpenAI 서버에 연결할 수 없습니다.' }, { status: 502 })
  }

  if (!openaiRes.ok) {
    const errText = await openaiRes.text()
    console.error(`[/api/chat] OpenAI ${openaiRes.status}:`, errText)
    return Response.json({ error: `OpenAI API 오류 (${openaiRes.status})` }, { status: 502 })
  }

  const data = await openaiRes.json()
  const content: string = data.choices?.[0]?.message?.content ?? '응답을 받지 못했습니다.'
  return Response.json({ content })
}

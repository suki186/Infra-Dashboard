// ─── POST /api/chat — OpenAI gpt-4o-mini 라우트 핸들러 ───────────────────────
// 요청: { message: string, metrics: MetricsMap }
// 응답: { content: string } | { error: string }

import type { MetricsMap } from '@/src/config/infrastructure'

// 두괄식 + <details> 강제 가이드 시스템 프롬프트
const SYSTEM_PROMPT =
  '당신은 고성능 실시간 인프라 관제탑의 시니어 DevOps AI 아키텍트입니다.' +
  ' 챗봇 가로 폭이 좁으므로, 모든 답변은 반드시 핵심 요약 2~3줄로 두괄식 시작하세요.' +
  ' 구체적인 트러블슈팅 명령어 리스트나 상세 설명은 유저가 선택적으로 펼쳐볼 수 있도록' +
  ' 다음 마크다운 양식으로 꽁꽁 감싸서 응답하세요:\n\n' +
  '<details><summary>🛠️ 상세 조치 가이드 및 CLI 명령어 보기</summary>\n\n' +
  '```bash\n# 여기에 실제 명령어\n```\n\n' +
  '</details>'

function buildUserMessage(message: string, metrics: MetricsMap): string {
  const entries = Object.entries(metrics)
  if (entries.length === 0) return `질문: ${message}`

  const snapshot = entries
    .map(([id, m]) =>
      `• [${id}]  CPU ${m.cpu_usage.toFixed(1)}%  /  MEM ${m.memory_usage.toFixed(1)}%`)
    .join('\n')

  return `현재 인프라 메트릭 스냅샷:\n${snapshot}\n\n질문: ${message}`
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다.' }, { status: 500 })
  }

  let body: { message?: string; metrics?: MetricsMap }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '잘못된 요청 형식입니다.' }, { status: 400 })
  }

  const { message, metrics = {} } = body
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
          { role: 'user',   content: buildUserMessage(message, metrics) },
        ],
        max_tokens:  900,
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

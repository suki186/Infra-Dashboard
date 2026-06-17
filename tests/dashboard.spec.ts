import { test, expect, type Page } from '@playwright/test'

/**
 * PulseOps 대시보드 — E2E 검증
 *
 * 실시간 스트리밍 특성상 고정 타이머(waitForTimeout) 대신
 * Playwright auto-waiting + locator 기반 toBeVisible() 을 사용한다.
 * (TC-05~07 의 channelReady() 이후 안전 마진에만 waitForTimeout 을 허용)
 */

// ── Supabase Realtime Phoenix 프로토콜 Mock ─────────────────────────────────
//
// @supabase/phoenix 의 Serializer (phoenix/serializer.js) 는 모든 메시지를
// JSON 배열 형식으로 인코딩/디코딩한다:
//
// ─────────────────────────────────────────────────────────────────────────────
async function setupRealtimeMock(page: Page) {
  // Phoenix topic → { joinRef, subIds }
  const topicState     = new Map<string, { joinRef: string; subIds: number[] }>()
  // topic → resolve 함수 (phx_join ack 전송 완료 후 호출)
  const topicResolvers = new Map<string, () => void>()
  const topicPromises  = new Map<string, Promise<void>>()
  let   sendFn: ((msg: string) => void) | null = null
  let   subIdCounter = 100

  // phx_join ack(phx_reply) 전송이 완료될 때까지 대기하는 Promise
  function channelReady(topic: string): Promise<void> {
    if (topicState.has(topic)) return Promise.resolve()
    if (!topicPromises.has(topic)) {
      topicPromises.set(
        topic,
        new Promise<void>(res => topicResolvers.set(topic, res)),
      )
    }
    return topicPromises.get(topic)!
  }

  // Supabase 프로젝트: yuktbrzxlnznydmrudkv.supabase.co
  await page.routeWebSocket(/yuktbrzxlnznydmrudkv\.supabase\.co\/realtime/, ws => {
    sendFn = (msg: string) => ws.send(msg)

    ws.onMessage(raw => {
      // ── 핵심 수정: 배열 형식으로 구조 분해 ───────────────────────────────
      // 브라우저 → 서버 메시지: [join_ref, ref, topic, event, payload]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let join_ref: string | null, ref: string | null, topic: string, event: string, payload: any
      try {
        ;[join_ref, ref, topic, event, payload] = JSON.parse(
          typeof raw === 'string' ? raw : (raw as Buffer).toString('utf-8'),
        )
      } catch {
        return
      }

      // ── Heartbeat ─────────────────────────────────────────────────────────
      // 브라우저: [null, ref, "phoenix", "heartbeat", {}]
      // 서버 응답: [null, ref, "phoenix", "phx_reply", {status:"ok"}]
      if (event === 'heartbeat') {
        ws.send(JSON.stringify([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }]))
        return
      }

      // ── Channel Join ──────────────────────────────────────────────────────
      // 브라우저: [join_ref, ref, topic, "phx_join", {config:{postgres_changes:[...]}}]
      // 서버 ack: [join_ref, ref, topic, "phx_reply", {status:"ok", response:{postgres_changes:[{id,event}]}}]
      // 순서 보장: send() 완료 → topicState 저장 → resolver 호출
      // (resolver 호출 전에 phx_reply 가 버퍼에 들어가야 postgres_changes 보다 먼저 처리됨)
      if (event === 'phx_join') {
        const pgFilters: Array<{ event: string; schema?: string; table?: string; filter?: string }> =
          payload?.config?.postgres_changes ?? []
        const subIds = pgFilters.map(() => ++subIdCounter)

        // ① phx_reply 먼저 전송 (브라우저 수신 큐에 먼저 삽입)
        //
        // _updatePostgresBindings() 가 serverFilter.schema / .table / .filter 을
        // clientFilter 와 isFilterValueEqual() 로 비교한다. 불일치 시 unsubscribe() 가 호출되므로
        // phx_join payload 의 postgres_changes 필터를 그대로 에코백해야 한다.
        ws.send(JSON.stringify([
          join_ref, ref, topic, 'phx_reply',
          {
            status:   'ok',
            response: {
              postgres_changes: subIds.map((id, i) => ({
                id,
                event:  pgFilters[i]?.event  ?? 'INSERT',
                schema: pgFilters[i]?.schema,
                table:  pgFilters[i]?.table,
                filter: pgFilters[i]?.filter,
              })),
            },
          },
        ]))

        // ② topicState 저장 후 channelReady() 해제
        // JS 싱글 스레드: 이 시점의 Promise 속행은 현재 동기 코드 완료 후 마이크로태스크로 예약됨
        // → phx_reply 가 postgres_changes 보다 반드시 먼저 브라우저 큐에 들어가는 것 보장
        topicState.set(topic, { joinRef: join_ref ?? ref ?? '', subIds })
        topicResolvers.get(topic)?.()
        return
      }

      // ── Channel Leave ─────────────────────────────────────────────────────
      if (event === 'phx_leave') {
        ws.send(JSON.stringify([join_ref, ref, topic, 'phx_reply', { status: 'ok', response: {} }]))
      }
    })
  })

  // ─── postgres_changes INSERT 이벤트 전송 ────────────────────────────────
  // 서버 → 브라우저: [join_ref, null, topic, "postgres_changes", {ids:[subId], data:{...}}]
  //
  // supabase-realtime-js _getPayloadRecords():
  //   payload.data.type === 'INSERT' → records.new = convertChangeData(columns, record)
  //   columns:[] 이면 noop(value) 로 원시값 그대로 통과
  function sendPgInsert(topic: string, table: string, schema: string, record: object) {
    const state = topicState.get(topic)
    if (!sendFn || !state) return
    sendFn(JSON.stringify([
      state.joinRef, null, topic, 'postgres_changes',
      {
        data: {
          type:             'INSERT',
          schema,
          table,
          commit_timestamp: new Date().toISOString(),
          errors:           null,
          record,
          old_record:       {},
          columns:          [],
        },
        ids: state.subIds,
      },
    ]))
  }

  return {
    // page.tsx: supabase.channel('infrastructure_metrics_feed')
    async injectMetric(record: object) {
      await channelReady('realtime:infrastructure_metrics_feed')
      // phx_reply 가 브라우저에서 완전히 처리(binding.id 세팅, 채널 joined 전환)된 뒤
      // postgres_changes 가 도착하도록 안전 마진 확보
      await page.waitForTimeout(300)
      sendPgInsert('realtime:infrastructure_metrics_feed', 'infrastructure_metrics', 'public', record)
    },
    // LogTerminal.tsx: supabase.channel('infrastructure_logs_feed')
    async injectLog(record: object) {
      await channelReady('realtime:infrastructure_logs_feed')
      await page.waitForTimeout(300)
      sendPgInsert('realtime:infrastructure_logs_feed', 'infrastructure_logs', 'public', record)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// ── TC-01~04. 핵심 컴포넌트 노출 테스트 ──────────────────────────────────────
test.describe('PulseOps 대시보드 핵심 컴포넌트 노출', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // page.tsx — 요약 카드는 Supabase 연결 여부와 무관하게 항상 렌더링된다
    await page.getByText('배포된 서버 수').waitFor({ state: 'visible' })
  })

  test('브라우저 탭 타이틀에 "PulseOps"가 포함된다', async ({ page }) => {
    await expect(page).toHaveTitle(/PulseOps/)
  })

  // page.tsx:130 — <h2>실시간 인프라 메트릭 스트리밍</h2>
  test('실시간 인프라 메트릭 관제 영역이 화면에 노출된다', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /실시간 인프라 메트릭/ })
    ).toBeVisible()
  })

  // PulseDoctor.tsx:145 — 데이터 수신 전후 placeholder 가 달라지므로 요소 가시성만 검증
  test('AI 챗봇 질문 입력창이 화면에 노출된다', async ({ page }) => {
    await expect(page.locator('input[type="text"]')).toBeVisible()
  })

  // LogTerminal.tsx:104 — 터미널 헤더에 항상 렌더링되는 명령어 텍스트로 식별
  test('시스템 로그 터미널이 화면에 노출된다', async ({ page }) => {
    await expect(
      page.getByText('tail -f /var/log/infrastructure.log')
    ).toBeVisible()
  })
})

// ── TC-05~07. 장애 시나리오 및 AI 진단 — WebSocket Mock 기반 ─────────────────
//
// · 별도 describe 블록: 바깥 beforeEach 의 미모킹 goto() 를 상속하지 않는다.
// · 각 테스트가 routeWebSocket 등록 → goto() 순서를 독립적으로 수행한다.
// · 프로덕션 코드를 단 한 줄도 수정하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('PulseOps 장애 시나리오 및 AI 진단', () => {
  // TC-05: 장애 주입 후 차트 위험 상태 변이 검증 ──────────────────────────────
  // infrastructure_metrics_feed 채널로 CPU 99% INSERT 이벤트를 주입
  // → page.tsx setMetrics() → deriveStats() → risk.color = 'text-red-400'
  // → 시스템 위험도 카드 value span 의 클래스가 text-red-400 으로 변이되는지 검증
  test('TC-05: CPU 99% 메트릭 WebSocket 주입 후 위험도 카드가 text-red-400 상태로 변이된다', async ({ page }) => {
    const mock = await setupRealtimeMock(page)

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.getByText('배포된 서버 수').waitFor({ state: 'visible' })

    // channelReady() 내부: phx_join ack 완료 대기 → 300ms 여유 → postgres_changes 전송
    await mock.injectMetric({
      server_id:    'kr-seoul-web-01',
      status:       'ONLINE',
      cpu_usage:    99,
      memory_usage: 88,
      disk_io:      97,
    })

    // infrastructureHelpers.ts: maxCpu >= 90 → risk = { label: '위험', color: 'text-red-400' }
    // page.tsx summaryCards[2] value span: className = `... ${card.color}` = 'text-red-400'
    await expect(
      page.locator('span.text-red-400').filter({ hasText: '위험' })
    ).toBeVisible()
  })

  // TC-06: 시스템 에러 로그 터미널 인입 검증 ────────────────────────────────
  // infrastructure_logs_feed 채널로 CRITICAL ERROR INSERT 이벤트를 주입
  // → LogTerminal logsRef 에 누적 → setTick() 리렌더 트리거
  // → 전체 페이지 리렌더 없이 터미널 바디 텍스트만 갱신됨을 검증
  test('TC-06: 로그 WebSocket 주입 후 터미널에 CRITICAL ERROR 패킷이 실시간 인입된다', async ({ page }) => {
    const mock = await setupRealtimeMock(page)

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.getByText('배포된 서버 수').waitFor({ state: 'visible' })

    await mock.injectLog({
      id:         1,
      created_at: new Date().toISOString(),
      server_id:  'kr-seoul-web-01',
      level:      'ERROR',
      message:    '[CRITICAL ERROR] CPU OVERLOAD: 99% — 즉각 조치 필요',
    })

    // LogTerminal 최외곽 컨테이너: div.bg-slate-950.rounded-xl
    // Sidebar 는 <aside>.bg-slate-950 이므로 div 선택자로 구별됨
    const logTerminal = page.locator('div.bg-slate-950.rounded-xl')
    await expect(logTerminal).toContainText('CRITICAL')
  })

  // TC-07: AI 챗봇 비동기 답변 검증 ─────────────────────────────────────────
  // 메트릭 주입 → hasData=true → 챗봇 입력창 활성화
  // → /api/chat 모킹 응답 → .pd-msg 말풍선에 키워드 비동기 렌더링 검증
  test('TC-07: 메트릭 주입으로 챗봇 활성화 후 AI 분석 답변이 비동기로 렌더링된다', async ({ page }) => {
    // /api/chat 을 모킹 — CI 환경에서도 OpenAI 키 없이 안정적으로 동작
    await page.route('/api/chat', route =>
      route.fulfill({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({
          content: 'AI 분석 결과: CPU 폭주가 감지되었습니다. kr-seoul-web-01 서버의 CPU 사용률이 99%에 달하는 심각한 과부하 상태입니다.',
        }),
      }),
    )

    const mock = await setupRealtimeMock(page)

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.getByText('배포된 서버 수').waitFor({ state: 'visible' })

    // 메트릭 주입 → usePulseDoctor: hasData = Object.keys(metrics).length > 0 → true
    // → PulseDoctor.tsx: input[disabled] 속성 제거
    await mock.injectMetric({
      server_id:    'kr-seoul-web-01',
      status:       'ONLINE',
      cpu_usage:    99,
      memory_usage: 88,
      disk_io:      97,
    })

    const chatInput = page.locator('input[type="text"]')
    // fill() 은 actionability auto-waiting 으로 disabled 해제까지 자동 대기
    await chatInput.fill('현재 시스템 장애 원인 분석해줘')
    await chatInput.press('Enter')

    // PulseDoctor.tsx: 어시스턴트 말풍선 className = 'pd-msg ...'
    await expect(
      page.locator('.pd-msg').last()
    ).toContainText('CPU 폭주가 감지되었습니다', { timeout: 10_000 })
  })
})

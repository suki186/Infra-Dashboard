import { test, expect, type Page } from '@playwright/test'
import type { ServerMetric, LogEntry, WSMessage } from '@infra-dashboard/shared'

/**
 * PulseOps 대시보드 — E2E 검증
 *
 * 실시간 스트리밍 특성상 고정 타이머(waitForTimeout) 대신
 * Playwright auto-waiting + locator 기반 toBeVisible() 을 사용한다.
 * TC-05~07: 단일 주입 후 대기 방식 대신 expect().toPass() 폴링 주입 패턴으로
 * Race Condition을 근본 해소한다 — 리스너 미등록 시 자동 재주입·재단언으로 수렴.
 */

// ── apps/server WebSocket(/ws) Mock ─────────────────────────────────────────
//
// 프론트는 ws://localhost:3001/ws 에 연결하고, 별도 핸드셰이크 없이
// 서버가 보내는 {type: 'metrics'|'log', payload: {...}} JSON 메시지를 그대로 수신한다
// (apps/server/src — packages/shared의 WSMessage). 클라이언트→서버 메시지가 없으므로
// onMessage 처리도, phx_join류 ack도 필요 없다.
//
// 연결은 앱 최상위(RealtimeSocketProvider → useRealtimeStore.connectSocket())에서
// 단 하나만 열린다. sockets 배열에 대한 브로드캐스트는 여러 연결을 지원하기 위한
// 범용 구현이지만, 실제로는 항상 단일 소켓에만 전달된다.
// ─────────────────────────────────────────────────────────────────────────────
async function setupServerSocketMock(page: Page) {
  const sockets: Parameters<Parameters<Page['routeWebSocket']>[1]>[0][] = []

  await page.routeWebSocket(/localhost:3001\/ws/, ws => {
    sockets.push(ws)
    ws.onClose(() => {
      const idx = sockets.indexOf(ws)
      if (idx >= 0) sockets.splice(idx, 1)
    })
  })

  function broadcast(message: WSMessage) {
    const raw = JSON.stringify(message)
    for (const ws of sockets) ws.send(raw)
  }

  return {
    injectMetric(payload: ServerMetric) {
      broadcast({ type: 'metrics', payload })
    },
    injectLog(payload: LogEntry) {
      broadcast({ type: 'log', payload })
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// ── apps/server REST(/api/metrics/history) Mock ─────────────────────────────
//
// useMetricsHistory 훅은 apps/server를 직접 호출한다 (NEXT_PUBLIC_API_URL 미설정 시
// http://localhost:3001로 기본 폴백). CI/로컬 테스트에서는 apps/server가 떠 있지
// 않으므로, 실제 네트워크 요청 대신 빈 페이지(과거 데이터 없음)로 응답해
// 무한 스크롤 로직이 조용히 "더 이상 없음" 상태로 안정되게 한다.
async function mockMetricsHistory(page: Page) {
  await page.route(/localhost:3001\/api\/metrics\/history/, route =>
    route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        JSON.stringify({ data: [], page: 1, limit: 150, total: 0 }),
    }),
  )
}

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────
// WebSocket 기반 실시간 앱은 네트워크가 항상 활성이므로 'networkidle'은 영원히 성립하지 않음.
// 대신 페이지가 실제로 사용 가능한 시점을 나타내는 고정 UI 요소(요약 카드)의 가시성으로 판단한다.
// page.tsx — 요약 카드는 WebSocket 연결 여부와 무관하게 항상 렌더링된다
async function gotoAndWaitReady(page: Page) {
  await mockMetricsHistory(page)
  await page.goto('/')
  await page.getByText('배포된 서버 수').waitFor({ state: 'visible' })
}

// ── TC-01~04. 핵심 컴포넌트 노출 테스트 ──────────────────────────────────────
test.describe('PulseOps 대시보드 핵심 컴포넌트 노출', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndWaitReady(page)
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
  // metrics 메시지로 CPU 99% 를 주입
  // → page.tsx setMetrics() → deriveStats() → risk.color = 'text-red-400'
  // → 시스템 위험도 카드 value span 의 클래스가 text-red-400 으로 변이되는지 검증
  test('TC-05: CPU 99% 메트릭 WebSocket 주입 후 위험도 카드가 text-red-400 상태로 변이된다', async ({ page }) => {
    const mock = await setupServerSocketMock(page)

    await gotoAndWaitReady(page)

    // 폴링 주입: useRealtimeStore 의 message 리스너가 아직 미등록인 경우 재주입으로 수렴
    // infrastructureHelpers.ts: maxCpu >= 90 → risk = { label: '위험', color: 'text-red-400' }
    await expect(async () => {
      mock.injectMetric({
        serverId:    'kr-seoul-web-01',
        status:      'ONLINE',
        cpuUsage:    99,
        memoryUsage: 88,
        diskIo:      97,
        createdAt:   new Date().toISOString(),
      })
      await expect(
        page.locator('span.text-red-400').filter({ hasText: '위험' })
      ).toBeVisible({ timeout: 500 })
    }).toPass({ intervals: [500], timeout: 10_000 })
  })

  // TC-06: 시스템 에러 로그 터미널 인입 검증 ────────────────────────────────
  // log 메시지로 CRITICAL ERROR 를 주입
  // → LogTerminal logsRef 에 누적 → setTick() 리렌더 트리거
  // → 전체 페이지 리렌더 없이 터미널 바디 텍스트만 갱신됨을 검증
  test('TC-06: 로그 WebSocket 주입 후 터미널에 CRITICAL ERROR 패킷이 실시간 인입된다', async ({ page }) => {
    const mock = await setupServerSocketMock(page)

    await gotoAndWaitReady(page)

    // 폴링 주입: useRealtimeStore 의 message 리스너가 미등록인 경우 재주입으로 수렴
    // LogTerminal 최외곽 컨테이너: div.bg-slate-950.rounded-xl (Sidebar <aside>와 구별)
    await expect(async () => {
      mock.injectLog({
        serverId:  'kr-seoul-web-01',
        level:     'ERROR',
        message:   '[CRITICAL ERROR] CPU OVERLOAD: 99% — 즉각 조치 필요',
        createdAt: new Date().toISOString(),
      })
      await expect(
        page.locator('div.bg-slate-950.rounded-xl')
      ).toContainText('CRITICAL', { timeout: 500 })
    }).toPass({ intervals: [500], timeout: 10_000 })
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

    const mock = await setupServerSocketMock(page)

    await gotoAndWaitReady(page)

    // Phase 1 — 폴링 주입: 메트릭 수신 → hasData=true → 챗봇 입력창 활성화 확인
    // usePulseDoctor: hasData = Object.keys(metrics).length > 0 → input[disabled] 제거
    await expect(async () => {
      mock.injectMetric({
        serverId:    'kr-seoul-web-01',
        status:      'ONLINE',
        cpuUsage:    99,
        memoryUsage: 88,
        diskIo:      97,
        createdAt:   new Date().toISOString(),
      })
      await expect(
        page.locator('input[type="text"]')
      ).toBeEnabled({ timeout: 500 })
    }).toPass({ intervals: [500], timeout: 10_000 })

    // Phase 2 — 챗봇 조작 및 AI 응답 단언 (챗봇 활성화 보장 후 순차 실행)
    const chatInput = page.locator('input[type="text"]')
    await chatInput.fill('현재 시스템 장애 원인 분석해줘')
    await chatInput.press('Enter')

    // PulseDoctor.tsx: 어시스턴트 말풍선 className = 'pd-msg ...'
    await expect(
      page.locator('.pd-msg').last()
    ).toContainText('CPU 폭주가 감지되었습니다', { timeout: 10_000 })
  })
})

// ── TC-08. 다중 서버 실시간 데이터 혼합 검증 ─────────────────────────────────
//
// TC-05~07은 단일 서버(kr-seoul-web-01) 메트릭만 주입해 검증했다.
// 실제 운영 환경에서는 3대(Seoul Web/DB, Jeju AI)의 메트릭이 뒤섞여 인입되므로,
// deriveStats()(app/page.tsx)가 서버별 값을 서로 덮어쓰거나 합산 오류 없이
// 정확히 분리 집계하는지를 검증한다.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('PulseOps 다중 서버 데이터 혼합 검증', () => {
  function summaryCardValue(page: Page, title: string) {
    // page.tsx summaryCards.map(): <p>{title}</p> 의 직계 부모가 카드 컨테이너이며,
    // 그 안의 첫 번째 <span>이 value(색상 클래스가 붙은 큰 숫자/라벨)이다.
    return page.getByText(title, { exact: true }).locator('..').locator('span').first()
  }

  test('TC-08: 3개 서버(Seoul Web/DB, Jeju AI)의 메트릭이 동시에 유입돼도 서버별 값이 섞이지 않고 요약 카드에 정확히 반영된다', async ({ page }) => {
    const mock = await setupServerSocketMock(page)

    await gotoAndWaitReady(page)

    // kr-seoul-db-01만 CPU 95%(위험 임계치 이상)로 주입하고 나머지 두 서버는 정상 범위로 유지해,
    // 알림·평균값 계산이 특정 서버 값으로 오염되지 않고 서버별로 정확히 분리 집계되는지 확인한다.
    await expect(async () => {
      const createdAt = new Date().toISOString()
      mock.injectMetric({ serverId: 'kr-seoul-web-01', status: 'ONLINE', cpuUsage: 20, memoryUsage: 30, diskIo: 5, createdAt })
      mock.injectMetric({ serverId: 'kr-seoul-db-01', status: 'ONLINE', cpuUsage: 95, memoryUsage: 60, diskIo: 40, createdAt })
      mock.injectMetric({ serverId: 'kr-jeju-ai-01', status: 'ONLINE', cpuUsage: 50, memoryUsage: 45, diskIo: 20, createdAt })

      // 배포된 서버 수: 3개 서버 모두 온라인으로 반영
      await expect(summaryCardValue(page, '배포된 서버 수')).toHaveText('3', { timeout: 500 })
    }).toPass({ intervals: [500], timeout: 10_000 })

    // 평균 CPU: (20 + 95 + 50) / 3 = 55.0 — 단일 서버 값으로 치우치지 않고 3개 서버 평균이 정확히 계산됨
    await expect(summaryCardValue(page, '평균 CPU')).toHaveText('55.0')

    // 활성 알림: CPU 90% 이상인 kr-seoul-db-01 1건만 카운트 — 나머지 정상 서버(20%, 50%)는 알림에 섞여 들지 않음
    await expect(
      page.getByText('활성 알림').locator('strong')
    ).toHaveText('1 건')

    // 시스템 위험도: 3개 서버 중 하나(kr-seoul-db-01)라도 90% 이상이면 전체 위험도가 '위험'으로 반영됨
    await expect(page.locator('span.text-red-400').filter({ hasText: '위험' })).toBeVisible()

    // 차트: 다중 서버 데이터 수신 후 메인 차트 캔버스의 'invisible' 클래스가 걷히고 렌더링 상태로 전환됨
    // (SERVER_STYLES에 등록된 3개 서버 모두 useRealtimeStore.ingest() 대상이므로 차트에도 반영된다.
    //  RealtimeChart.tsx: 페인트 타이머가 데이터 수신 시 canvasRef의 'invisible' 클래스를 제거한다.
    //  Y축 캔버스는 애초에 'invisible' 클래스를 갖지 않으므로 이 선택자는 메인 캔버스만 가리킨다.)
    await expect(page.locator('canvas.invisible')).toHaveCount(0)
  })
})

// ── TC-09~10. 에러/예외 상황 검증 ────────────────────────────────────────────
test.describe('PulseOps 에러/예외 상황 검증', () => {
  // TC-09: WebSocket 연결 종료 시 재연결 시도 검증 ──────────────────────────
  // useRealtimeStore.ts openSocket(): socket의 'close' 이벤트 발생 시
  // setTimeout(connect, RECONNECT_DELAY_MS=2000)으로 재연결을 예약한다.
  // 서버측에서 연결을 끊어 클라이언트 'close' 이벤트를 유도한 뒤,
  // 새 WebSocket 연결 시도(=routeWebSocket 핸들러 재호출)가 실제로 발생하는지 검증한다.
  test('TC-09: WebSocket 연결이 서버측에서 끊기면 프론트가 약 2초 후 자동으로 재연결을 시도한다', async ({ page }) => {
    let connectionCount = 0
    const sockets: Parameters<Parameters<Page['routeWebSocket']>[1]>[0][] = []

    await mockMetricsHistory(page)
    await page.routeWebSocket(/localhost:3001\/ws/, ws => {
      connectionCount++
      sockets.push(ws)
    })

    await page.goto('/')
    await page.getByText('배포된 서버 수').waitFor({ state: 'visible' })

    // 최초 연결(RealtimeSocketProvider → connectSocket())이 열릴 때까지 대기
    await expect.poll(() => connectionCount, { timeout: 10_000 }).toBe(1)

    // 서버측에서 연결을 끊는다 — 기본 forwarding 동작에 의해 페이지 측 WebSocket도 'close' 이벤트를 받는다
    await sockets[0].close()

    // RECONNECT_DELAY_MS(2000ms) 경과 후 재연결이 시도돼 connectionCount가 2로 증가하는지 확인
    await expect.poll(() => connectionCount, { timeout: 8_000 }).toBe(2)
  })

  // TC-10: 잘못된(500) 히스토리 API 응답 시 프론트 크래시 방지 검증 ─────────
  // useMetricsHistory(useInfiniteQuery)는 GET /api/metrics/history가 실패해도
  // isError 상태로만 전환될 뿐 예외를 던지지 않아야 한다.
  // 대시보드 핵심 UI(요약 카드 등)가 정상적으로 렌더링되고, 처리되지 않은
  // JS 예외(pageerror)가 발생하지 않는지 검증한다.
  test('TC-10: 히스토리 API가 500 오류를 반환해도 대시보드가 크래시하지 않고 정상적으로 렌더링된다', async ({ page }) => {
    const pageErrors: Error[] = []
    page.on('pageerror', (err) => pageErrors.push(err))

    await page.route(/localhost:3001\/api\/metrics\/history/, route =>
      route.fulfill({
        status:      500,
        contentType: 'application/json',
        body:        JSON.stringify({ error: 'internal server error' }),
      }),
    )

    const historyResponse = page.waitForResponse(/localhost:3001\/api\/metrics\/history/)
    await page.goto('/')
    await historyResponse

    // 히스토리 API 실패와 무관하게 대시보드 핵심 영역은 정상적으로 노출된다
    await expect(page.getByText('배포된 서버 수')).toBeVisible()
    await expect(page.getByRole('heading', { name: /실시간 인프라 메트릭/ })).toBeVisible()

    // 처리되지 않은 예외로 페이지가 죽지 않았는지 확인
    expect(pageErrors).toHaveLength(0)
  })
})

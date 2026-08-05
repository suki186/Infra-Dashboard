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

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────
// WebSocket 기반 실시간 앱은 네트워크가 항상 활성이므로 'networkidle'은 영원히 성립하지 않음.
// 대신 페이지가 실제로 사용 가능한 시점을 나타내는 고정 UI 요소(요약 카드)의 가시성으로 판단한다.
// page.tsx — 요약 카드는 WebSocket 연결 여부와 무관하게 항상 렌더링된다
async function gotoAndWaitReady(page: Page) {
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

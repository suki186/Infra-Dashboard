import { test, expect } from '@playwright/test'

/**
 * PulseOps 대시보드 — 핵심 컴포넌트 노출 E2E 검증
 *
 * 실시간 스트리밍 특성상 고정 타이머(waitForTimeout) 대신
 * Playwright auto-waiting + locator 기반 toBeVisible()을 사용한다.
 */

test.describe('PulseOps 대시보드 핵심 컴포넌트 노출', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // WebSocket 초기 핸드셰이크를 포함한 네트워크 통신이 잠잠해질 때까지 대기
    await page.waitForLoadState('networkidle')
    // React hydration 및 대시보드 뼈대 렌더링 완료를 보장하는 명시적 앵커
    // page.tsx — 요약 카드는 Supabase 연결 여부와 무관하게 항상 렌더링된다
    await page.getByText('배포된 서버 수').waitFor({ state: 'visible' })
  })

  // ── 1. 브라우저 탭 타이틀 ─────────────────────────────────────────────────
  test('브라우저 탭 타이틀에 "PulseOps"가 포함된다', async ({ page }) => {
    await expect(page).toHaveTitle(/PulseOps/)
  })

  // ── 2. 실시간 인프라 메트릭 관제 영역 ─────────────────────────────────────
  // page.tsx:130 — <h2>실시간 인프라 메트릭 스트리밍</h2>
  test('실시간 인프라 메트릭 관제 영역이 화면에 노출된다', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /실시간 인프라 메트릭/ })
    ).toBeVisible()
  })

  // ── 3. AI 챗봇 질문 입력창 ────────────────────────────────────────────────
  // PulseDoctor.tsx:145 — placeholder는 Supabase 연결 여부에 따라 동적으로 변경됨:
  //   · 데이터 수신 전(테스트 환경 초기): "데이터 스트리밍 연결 대기 중..."
  //   · 데이터 수신 후:                   "서버 상태를 질문하세요..."
  // 두 상태 모두에서 안정적으로 동작하도록 입력창 요소 자체의 가시성을 검증한다.
  test('AI 챗봇 질문 입력창이 화면에 노출된다', async ({ page }) => {
    const chatInput = page.locator('input[type="text"]')
    await expect(chatInput).toBeVisible()
  })

  // ── 4. 시스템 로그 터미널 ─────────────────────────────────────────────────
  // LogTerminal.tsx:104 — 터미널 헤더에 항상 렌더링되는 명령어 텍스트로 식별
  test('시스템 로그 터미널이 화면에 노출된다', async ({ page }) => {
    await expect(
      page.getByText('tail -f /var/log/infrastructure.log')
    ).toBeVisible()
  })

  // ── TC-05. 장애 주입 후 위험 상태 클래스 변이 검증 ────────────────────────
  // page.tsx:handleFaultInject — CPU 99% 메트릭 주입 → deriveStats → risk.color=text-red-400
  // 시스템 위험도 요약 카드의 value span 클래스가 text-red-400 으로 변이되는지 검증한다.
  test('TC-05: 장애 주입 후 시스템 위험도 카드가 위험(text-red-400) 상태로 변이된다', async ({ page }) => {
    await page.getByTestId('fault-inject-btn').click()

    // risk.color = 'text-red-400', risk.label = '위험' → summaryCards[2] value span
    await expect(
      page.locator('span.text-red-400').filter({ hasText: '위험' })
    ).toBeVisible()
  })

  // ── TC-06. 시스템 에러 로그 터미널 인입 검증 ──────────────────────────────
  // LogTerminal.tsx:injectLog — 장애 주입 버튼 클릭 시 CRITICAL ERROR 메시지가
  // 터미널 바디(bg-slate-950.rounded-xl) 내부에 누적 출력되는지 검증한다.
  // 전체 페이지 리렌더링 없이 터미널 내부 텍스트만 갱신되므로 깜빡임이 없다.
  test('TC-06: 장애 주입 후 로그 터미널에 CRITICAL ERROR 패킷이 실시간 인입된다', async ({ page }) => {
    await page.getByTestId('fault-inject-btn').click()

    // LogTerminal 최외곽 컨테이너: div.bg-slate-950.rounded-xl (Sidebar의 aside와 구별)
    const logTerminal = page.locator('div.bg-slate-950.rounded-xl')
    await expect(logTerminal).toContainText('CRITICAL')
  })

  // ── TC-07. AI 챗봇 비동기 답변 검증 ────────────────────────────────────────
  // 장애 주입으로 hasData=true 전환 → 챗봇 입력창 활성화 → 질문 전송 →
  // /api/chat 응답(모킹)이 .pd-msg 어시스턴트 말풍선에 비동기로 렌더링되는지 검증한다.
  test('TC-07: AI 챗봇이 장애 분석 질문에 대한 답변을 비동기로 반환한다', async ({ page }) => {
    // /api/chat 를 모킹하여 CI 환경에서도 안정적으로 동작하도록 한다.
    await page.route('/api/chat', route =>
      route.fulfill({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({
          content: 'AI 분석 결과: CPU 폭주가 감지되었습니다. kr-seoul-web-01 서버의 CPU 사용률이 99%에 달하는 심각한 과부하 상태입니다.',
        }),
      })
    )

    // 장애 주입 → hasData=true → 입력창 활성화
    await page.getByTestId('fault-inject-btn').click()

    const chatInput = page.locator('input[type="text"]')
    // Playwright actionability auto-waiting: disabled 해제까지 자동 대기
    await chatInput.fill('현재 시스템 장애 원인 분석해줘')
    await chatInput.press('Enter')

    // 어시스턴트 말풍선(.pd-msg) 내에 AI 분석 키워드가 비동기로 나타날 때까지 대기
    await expect(
      page.locator('.pd-msg').last()
    ).toContainText('CPU 폭주가 감지되었습니다', { timeout: 10_000 })
  })
})

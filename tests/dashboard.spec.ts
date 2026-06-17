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
})

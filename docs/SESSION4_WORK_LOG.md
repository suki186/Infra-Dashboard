# Session 4 Work Log — Playwright E2E 테스트 인프라 구축 및 CI/CD 파이프라인 완성

> **Branch** `feat/playwright-test`

---

## 목차

1. [세션 개요](#overview)
2. [테스트 케이스 구축 내역 (TC-01 ~ TC-07)](#test-cases)
3. [핵심 트러블슈팅 케이스 스터디](#troubleshooting)
4. [CI/CD 파이프라인 구성](#cicd)
5. [최종 성과 요약](#summary)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

Session 3에서 완성된 PulseOps 대시보드는 Supabase Realtime WebSocket, AI 챗봇(`/api/chat`), 실시간 로그 터미널이라는 세 개의 비동기 데이터 레이어가 유기적으로 맞물려 동작하는 구조를 가진다. 이 복합 실시간 아키텍처는 단위 테스트나 정적 분석만으로는 실제 브라우저 렌더링 결과를 보장할 수 없다.

### 목표

- 프로덕션 코드를 **단 한 줄도 수정하지 않고**, 순수 테스트 레이어에서 WebSocket 스트림을 가로채 장애 시나리오를 재현한다.
- 실제 Supabase 서버 및 OpenAI API 없이 CI 환경에서 완전 격리된 E2E 검증을 달성한다.
- GitHub Actions 워크플로우를 통해 `main` 브랜치 병합 전 자동 품질 게이트를 확립한다.

### 기술 스택

| 항목 | 선택 |
|------|------|
| E2E 프레임워크 | Playwright (`@playwright/test`) |
| WebSocket 인터셉션 | `page.routeWebSocket()` |
| 프로토콜 | Supabase Realtime (Phoenix Protocol, 배열 직렬화) |
| CI 플랫폼 | GitHub Actions (`ubuntu-latest`) |
| 대상 브라우저 | Chromium (`Desktop Chrome`) |

---

<a id="test-cases"></a>
## 2. 테스트 케이스 구축 내역 (TC-01 ~ TC-07)

### 2-1. 렌더링 검증 2단계 방어벽 설계 (TC-01 ~ TC-04)

#### 문제 인식

`page.goto('/')` 이후 즉시 요소를 조회하면 React Hydration이 완료되기 전이거나 Suspense 경계가 아직 해소되지 않은 상태일 수 있다. 초기 구현에서는 간헐적으로 요소를 찾지 못하는 flaky 현상이 발생했다.

#### 해결: 2단계 방어벽 (networkidle + Hydration 앵커)

```typescript
await page.goto('/')
await page.waitForLoadState('networkidle')          // 1단계: 네트워크 유휴 대기
await page.getByText('배포된 서버 수').waitFor({ state: 'visible' }) // 2단계: Hydration 앵커
```

- **1단계 (`networkidle`)**: 외부 리소스 로딩 및 초기 API 호출이 모두 안정화된 시점을 포착한다.
- **2단계 (Hydration 앵커 `'배포된 서버 수'`)**: `page.tsx`의 요약 카드는 Supabase 연결 여부와 무관하게 항상 렌더링된다. 이 텍스트의 가시성이 확인되면 React Hydration이 완료되었음을 보장할 수 있다.

이 패턴을 `test.beforeEach()`에 선언적으로 적용함으로써 TC-01 ~ TC-04 전체의 시작 조건을 일관성 있게 통제했다.

#### TC-01 ~ TC-04 검증 항목

| TC | 검증 대상 | 로케이터 전략 |
|----|-----------|--------------|
| TC-01 | 브라우저 탭 타이틀 `/PulseOps/` | `expect(page).toHaveTitle()` |
| TC-02 | 실시간 인프라 메트릭 관제 heading | `getByRole('heading', { name: /실시간 인프라 메트릭/ })` |
| TC-03 | AI 챗봇 질문 입력창 | `locator('input[type="text"]')` |
| TC-04 | 시스템 로그 터미널 헤더 | `getByText('tail -f /var/log/infrastructure.log')` |

---

### 2-2. WebSocket 모킹 기반 장애 시뮬레이션 (TC-05 ~ TC-07)

TC-05 ~ TC-07은 별도의 `test.describe` 블록으로 분리하여 TC-01 ~ TC-04의 `beforeEach`(미모킹 `goto()`)를 상속하지 않는다. 각 테스트가 `routeWebSocket` 등록 → `goto()` 순서를 독립적으로 수행함으로써 완전한 격리를 보장한다.

#### TC-05: CPU 폭주 장애 주입 및 위험도 카드 상태 변이 검증

```
WebSocket Mock ──INSERT(cpu_usage=99)──▶ page.tsx setMetrics()
  ▶ deriveStats() ──▶ maxCpu >= 90 ──▶ risk.color = 'text-red-400'
  ▶ summaryCards[2].value span.className ──▶ 'text-red-400' 변이 확인
```

`infrastructure_metrics_feed` 채널로 `cpu_usage: 99` INSERT 이벤트를 주입하고, `infrastructureHelpers.ts`의 `maxCpu >= 90` 분기가 위험도 카드를 `text-red-400`으로 변이시키는 전체 데이터 플로우를 E2E로 검증한다.

#### TC-06: CRITICAL ERROR 로그 실시간 인입 검증

`infrastructure_logs_feed` 채널로 `level: 'ERROR'` INSERT 이벤트를 주입하여 `LogTerminal`의 `logsRef` 누적 → `setTick()` 리렌더 트리거까지의 파이프라인을 검증한다. 전체 페이지 리렌더 없이 터미널 바디 텍스트만 갱신됨을 `div.bg-slate-950.rounded-xl` 로케이터로 격리 확인했다.

#### TC-07: AI 챗봇 비동기 스트리밍 답변 검증

```
메트릭 주입 ──▶ usePulseDoctor: hasData = true ──▶ input[disabled] 해제
  ──▶ chatInput.fill() [auto-wait] ──▶ Enter ──▶ /api/chat 모킹 응답
  ──▶ .pd-msg 말풍선 비동기 렌더링 ──▶ 'CPU 폭주가 감지되었습니다' 포함 검증
```

CI 환경에서 OpenAI API 키 없이도 안정적으로 동작하도록 `/api/chat` 엔드포인트를 `page.route()`로 모킹했다. `chatInput.fill()`은 Playwright의 actionability auto-waiting을 활용해 `disabled` 해제까지 자동 대기하므로 별도의 타이머가 불필요하다.

---

<a id="troubleshooting"></a>
## 3. 핵심 트러블슈팅 케이스 스터디

> 이번 세션에서 가장 많은 시간이 소요된 영역이자, 가장 중요한 엔지니어링 인사이트가 도출된 구간이다.

### 3-1. 증상: 30초 타임아웃 에러의 반복 발생

TC-05 ~ TC-06 구현 초기, WebSocket 모킹을 통해 `phx_join` 핸드셰이크까지는 성공하는 것이 확인되었으나, 이후 `sendPgInsert()`로 전송한 `postgres_changes` 이벤트가 브라우저 `setMetrics()` / `setLogs()`를 전혀 트리거하지 않았다. Playwright 기본 타임아웃인 **30초가 소진된 뒤 `TimeoutError`**가 발생했다.

```
TimeoutError: Timed out 30000ms waiting for expect(locator).toBeVisible()
  Locator: locator('span.text-red-400')
```

표면적으로는 단순한 DOM 렌더링 미발생처럼 보였지만, 원인은 라이브러리 코어 레벨에 있었다.

---

### 3-2. 원인 분석: `@supabase/realtime-js` 내부 검증 로직

#### `_updatePostgresBindings()` 와 `isFilterValueEqual()`

`@supabase/realtime-js`는 서버로부터 `phx_reply` 응답을 수신할 때 `_updatePostgresBindings()` 를 호출한다. 이 메서드는 클라이언트가 `phx_join` 시 등록한 필터 목록(clientFilter)과 서버 응답의 `postgres_changes` 배열(serverFilter)을 `isFilterValueEqual()` 함수로 1:1 비교한다.

```
clientFilter:  { event: '*', schema: 'public', table: 'infrastructure_metrics' }
serverFilter:  { id: 101, event: 'INSERT' }   ← schema, table 누락!
```

비교 결과 **불일치**가 감지되면 라이브러리는 채널 바인딩 업데이트에 실패하고, 채널을 `joined` 상태로 전환하지 않으며, 최악의 경우 **`unsubscribe()`를 강제 호출**한다. 이로 인해 이후 전송되는 `postgres_changes` 이벤트는 유효한 바인딩 대상이 없어 그대로 드롭되었다.

#### 초기 모킹 코드의 결함

```typescript
// ❌ 잘못된 phx_reply: 서버 필터에 schema, table 정보가 없음
ws.send(JSON.stringify([
  join_ref, ref, topic, 'phx_reply',
  {
    status: 'ok',
    response: {
      postgres_changes: subIds.map((id, i) => ({
        id,
        event: pgFilters[i]?.event ?? 'INSERT',
        // schema, table, filter 필드 누락
      })),
    },
  },
]))
```

---

### 3-3. 해결책: 실제 Supabase 서버 응답 구조 미러링

**핵심 원칙**: 목 서버는 실제 Supabase 서버가 반환하는 `phx_reply` 구조를 그대로 에코백(echo-back)해야 한다. 클라이언트가 `phx_join` 페이로드로 보낸 `postgres_changes` 필터 배열을 **동일한 `schema`, `table`, `filter` 값과 함께** 서버 응답으로 돌려줌으로써 `isFilterValueEqual()` 검증을 통과시켰다.

```typescript
// ✅ 수정된 phx_reply: 클라이언트 필터를 그대로 에코백
ws.send(JSON.stringify([
  join_ref, ref, topic, 'phx_reply',
  {
    status: 'ok',
    response: {
      postgres_changes: subIds.map((id, i) => ({
        id,
        event:  pgFilters[i]?.event  ?? 'INSERT',
        schema: pgFilters[i]?.schema,   // ← 추가
        table:  pgFilters[i]?.table,    // ← 추가
        filter: pgFilters[i]?.filter,   // ← 추가
      })),
    },
  },
]))
```

#### 추가 해결: 이벤트 전송 순서 보장

또 다른 미묘한 레이스 컨디션이 존재했다. `phx_reply`가 브라우저의 수신 큐에 도달하기 전에 `postgres_changes` 이벤트가 먼저 처리될 경우, 채널이 아직 `joined` 상태가 아니므로 이벤트가 드롭된다.

이를 해결하기 위해 두 가지 전략을 병행했다.

1. **`channelReady()` Promise**: `phx_reply` 전송 완료 후 `topicResolvers.get(topic)?.()` 호출로 `channelReady()` Promise를 해제한다. `injectMetric()` / `injectLog()` 는 이 Promise를 먼저 `await` 한 뒤 데이터를 전송한다.

2. **300ms 안전 마진**: JS 싱글스레드 환경에서 `phx_reply` 처리(바인딩 ID 세팅, 채널 `joined` 전환)가 완료될 충분한 여유를 확보한다.

```typescript
async injectMetric(record: object) {
  await channelReady('realtime:infrastructure_metrics_feed') // phx_reply 수신 대기
  await page.waitForTimeout(300)                            // 채널 상태 전환 여유
  sendPgInsert('realtime:infrastructure_metrics_feed', ...)
}
```

---

### 3-4. 결과

위 두 가지 수정 적용 후 TC-01 ~ TC-07 **전원 Pass** 달성.

```
✓  TC-01  브라우저 탭 타이틀에 "PulseOps"가 포함된다
✓  TC-02  실시간 인프라 메트릭 관제 영역이 화면에 노출된다
✓  TC-03  AI 챗봇 질문 입력창이 화면에 노출된다
✓  TC-04  시스템 로그 터미널이 화면에 노출된다
✓  TC-05  CPU 99% 메트릭 WebSocket 주입 후 위험도 카드가 text-red-400 상태로 변이된다
✓  TC-06  로그 WebSocket 주입 후 터미널에 CRITICAL ERROR 패킷이 실시간 인입된다
✓  TC-07  메트릭 주입으로 챗봇 활성화 후 AI 분석 답변이 비동기로 렌더링된다

7 passed (38.2s)
```

---

<a id="cicd"></a>
## 4. CI/CD 파이프라인 구성

### 4-1. GitHub Actions 워크플로우 설계 의도

`.github/workflows/playwright.yml` 은 `main` 브랜치로의 `push` 및 `pull_request` 이벤트에서 자동으로 실행되는 E2E 품질 게이트다.

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

### 4-2. 주요 스텝 구성

| 스텝 | 내용 |
|------|------|
| `actions/checkout@v4` | 소스 체크아웃 |
| `actions/setup-node@v4` (Node 20) | `npm cache` 연동으로 의존성 설치 속도 최적화 |
| `npm ci` | `package-lock.json` 기반 재현 가능 설치 |
| `npx playwright install --with-deps chromium` | Chromium 단일 브라우저만 설치하여 CI 시간 단축 |
| `npm run test:e2e` | `playwright.config.ts` 실행 (`webServer` 자동 기동 포함) |

환경 변수 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`는 GitHub Repository Secrets에서 주입되어 Next.js dev 서버가 정상 기동되도록 한다. 테스트 자체는 WebSocket 모킹으로 실제 Supabase 연결이 불필요하지만, 서버 기동 시 환경 변수 유효성 검사를 통과하기 위해 필요하다.

### 4-3. `failure()` 조건부 아티팩트 업로드 최적화

```yaml
- name: Upload Playwright report on failure
  uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: playwright-report
    path: playwright-report/
    retention-days: 30
```

`if: failure()` 조건을 적용함으로써 **테스트 성공 시에는 아티팩트를 업로드하지 않는다.** 이는 두 가지 효과를 가진다.

- **스토리지 절약**: 불필요한 HTML 리포트 업로드를 방지해 GitHub Actions 아티팩트 스토리지를 절약한다.
- **노이즈 감소**: 성공 실행에 첨부 파일이 없으므로, 실패 시 생성된 아티팩트가 즉시 눈에 띈다.

`retention-days: 30` 설정으로 실패 리포트는 30일간 보존되어 비동기적인 장애 분석이 가능하다.

### 4-4. Playwright 설정 핵심 파라미터

```typescript
// playwright.config.ts
export default defineConfig({
  forbidOnly: !!process.env.CI,   // CI에서 test.only 사용 시 빌드 실패 처리
  retries: process.env.CI ? 2 : 0, // CI에서만 2회 재시도 (flaky 방어)
  workers: process.env.CI ? 1 : undefined, // CI에서 단일 워커로 리소스 경쟁 방지
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI, // CI에서 항상 새 서버 기동
    timeout: 120_000,
  },
})
```

---

<a id="summary"></a>
## 5. 최종 성과 요약

### 달성 항목

| 항목 | 내용 |
|------|------|
| E2E 테스트 커버리지 | TC-01 ~ TC-07, 7개 전원 Pass |
| 프로덕션 코드 변경 | 0줄 (순수 테스트 레이어 격리) |
| 외부 의존성 | Supabase, OpenAI 모두 격리 (100% 모킹) |
| CI 자동화 | GitHub Actions — `main` PR 머지 전 자동 품질 게이트 |
| 핵심 버그 해결 | `@supabase/realtime-js` 내부 필터 검증 우회 |

### 엔지니어링 인사이트

> **"Third-party 라이브러리를 모킹할 때는 해당 라이브러리 소스 코드를 직접 읽어야 한다."**

`@supabase/realtime-js`의 `_updatePostgresBindings()` / `isFilterValueEqual()` 로직은 공식 문서에 기술되어 있지 않다. 30초 타임아웃 에러의 표면적 증상만으로는 원인을 특정할 수 없었으며, 라이브러리 소스 코드를 직접 추적하여 실제 서버 응답 구조와 동일하게 모킹해야 한다는 결론에 도달했다. 이는 **블랙박스 라이브러리 통합 테스트 시 화이트박스 분석이 필수적**임을 방증하는 사례다.

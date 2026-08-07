# apps/web

Next.js 기반 실시간 인프라 관제 대시보드 프론트엔드. [apps/server](../server)의 WebSocket(`/ws`)을 단일 연결로 구독해 메트릭·로그를 스트리밍 렌더링하고, GPT-4o-mini가 메트릭+로그를 교차 분석해 장애를 진단한다.

백엔드는 [apps/server](../server), 두 워크스페이스가 공유하는 타입은 [packages/shared](../../packages/shared) 참고.

---

## 기술 스택

| 분류 | 기술 |
|---|---|
| 프레임워크 | Next.js 16 (App Router) |
| UI | React 19, TypeScript 5, Tailwind CSS v4 |
| 실시간 상태 | Zustand 5 (`useRealtimeStore` — WebSocket 단일 연결 소유) |
| 과거 데이터 조회 | TanStack Query 5 (`useInfiniteQuery` 커서 기반 무한 스크롤) |
| 차트 렌더링 | Chart.js 4 코어 (imperative API, `useRef` 캔버스에 직접 드로우) |
| AI | OpenAI GPT-4o-mini (`app/api/chat/route.ts`에서 서버 사이드 호출) |
| 테스트 | Playwright (`@playwright/test`) |

---

## 주요 기능

| 기능 | 구현 위치 | 설명 |
|---|---|---|
| 실시간 요약 카드 | `app/page.tsx` | 배포 서버 수·평균 CPU·시스템 위험도를 `useRealtimeStore`에서 파생 계산 |
| 60fps 실시간 차트 | `src/components/dashboard/RealtimeChart.tsx` + `useChartPaint` | `chart.update('none')` + 300ms 독립 페인트 루프, Y축 LERP 동적 스케일링, 서버별 필터 토글 |
| 로그 터미널 스트리밍 | `src/components/dashboard/LogTerminal.tsx` | `forwardRef` + `useImperativeHandle`로 격리, 로그 도착 시 상위 트리 재렌더 없이 서브트리만 갱신 |
| AI 챗봇 (교차 진단) | `src/components/chatbot/PulseDoctor.tsx` + `usePulseDoctor.ts` | 질문 시점 메트릭 스냅샷 + 최근 로그 10줄을 GPT-4o-mini에 함께 주입, 서버 ID·타임스탬프 근거 기반 진단 |
| 무한 스크롤 히스토리 | `src/hooks/useMetricsHistory.ts` | 차트를 왼쪽으로 스크롤하면 `/api/metrics/history`를 커서 기반으로 추가 조회, 실시간 슬롯과 `Map` 기반 dedup 병합 |

---

## 폴더 구조

```
app/
├── api/chat/route.ts        AI 챗봇 API 라우트 — OPENAI_API_KEY 서버 사이드 격리
├── page.tsx                 대시보드 메인 (Client Component) — 요약 카드 + 차트 + 로그 + 챗봇 조립
└── layout.tsx                RootLayout — QueryProvider/RealtimeSocketProvider/Sidebar 최상위 마운트

src/
├── components/
│   ├── chatbot/
│   │   ├── PulseDoctor.tsx      AI 챗봇 UI
│   │   └── usePulseDoctor.ts    챗봇 상태/비즈니스 로직 훅
│   ├── common/
│   │   ├── QueryProvider.tsx           TanStack Query QueryClient 지연 초기화 (useState)
│   │   ├── RealtimeSocketProvider.tsx  UI 없는 컴포넌트 — 앱 최상위에서 WebSocket 연결을 1회만 초기화
│   │   └── Sidebar.tsx
│   └── dashboard/
│       ├── RealtimeChart.tsx        선언형 UI만 — useChartPaint 훅 호출 한 줄로 로직 위임
│       ├── RealtimeChart.utils.ts   렌더링 의존성 0인 순수 함수 (LERP 상수, floorTo5/ceilTo5, computeCombined)
│       ├── RealtimeChart.config.ts  Chart.js 옵션/초기 데이터셋
│       └── LogTerminal.tsx
├── hooks/
│   ├── useChartPaint.ts       차트의 모든 사이드 이펙트 전담 (페인트 타이머, IntersectionObserver, Y축 LERP, 서버 필터)
│   └── useMetricsHistory.ts   useInfiniteQuery로 /api/metrics/history 커서 페이징
├── store/
│   └── useRealtimeStore.ts    Zustand — WebSocket 단일 연결 소유 + 실시간 슬롯/메트릭/로그 상태
├── services/
│   └── aiApi.ts               sendChatQuestionApi() — /api/chat 호출 분리
├── config/
│   └── infrastructure.ts      서버 목록, 색상, ServerMetric/MetricsMap 타입 등 단일 진실 공급원
├── types/
│   ├── chat.ts
│   ├── metrics.ts
│   └── terminal.ts
└── utils/
    └── infrastructureHelpers.ts   deriveStats 등 요약 카드 파생 로직

scripts/
└── simulator.mjs             가상 메트릭/로그 생성기 — apps/server REST(POST /api/metrics, /api/logs)로 전송

tests/
└── dashboard.spec.ts         Playwright E2E (TC-01~10)

docs/
└── SESSION*_WORK_LOG.md      세션별 작업 로그
```

---

## 환경 변수

`.env.example` 기준.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:3001/ws` | `apps/server`의 WebSocket 엔드포인트. 로컬 개발 시 미설정해도 기본값이 로컬 서버를 가리킨다 |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` | `apps/server`의 REST 엔드포인트 (히스토리 조회용). 마찬가지로 로컬 개발 시 기본값 그대로 사용 가능 |
| `OPENAI_API_KEY` | — | AI 챗봇(`app/api/chat/route.ts`)에서 사용. 없어도 대시보드는 정상 동작 |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | — | **레거시.** Supabase Realtime을 직접 구독하던 초기 구조의 흔적 |

---

## 로컬 실행

루트에서 `npm install`을 마쳤다는 전제로:

```bash
cp apps/web/.env.example apps/web/.env
npm run dev:web   # http://localhost:3000
```

`NEXT_PUBLIC_WS_URL`/`NEXT_PUBLIC_API_URL`을 어디로 향하게 하느냐에 따라 두 가지 방식으로 백엔드를 붙일 수 있다.

- **로컬 백엔드** (기본값): `apps/server`를 직접 기동한다. `.env`를 비워두면 자동으로 `localhost:3001`을 바라본다.
  ```bash
  npm run dev:server   # 별도 터미널
  ```
- **배포된 Render 백엔드**: 로컬에서 서버를 띄우지 않고 배포 환경에 붙여보고 싶을 때 `.env`를 덮어쓴다.
  ```bash
  NEXT_PUBLIC_WS_URL=wss://infra-dashboard-server.onrender.com/ws
  NEXT_PUBLIC_API_URL=https://infra-dashboard-server.onrender.com
  ```
  Render 무료 플랜은 콜드 스타트가 있어 첫 요청이 느릴 수 있다.

둘 중 어느 쪽이든, 대시보드에 데이터가 흐르려면 백엔드에 메트릭/로그가 계속 들어와야 한다 — 로컬 서버라면 `npm run simulate --workspace=apps/web`(또는 서버의 `DEMO_MODE=true`), Render 백엔드라면 이미 `DEMO_MODE`로 자체 데이터를 생성 중이므로 별도 조치가 필요 없다.

---

## 상태관리 설계 — Zustand vs TanStack Query

실시간 메트릭/로그는 서버가 초당 여러 번 **밀어주는(push)** 데이터라 React의 렌더 사이클과 무관하게 최대한 빨리 받아 쌓아야 하고, 컴포넌트 리렌더를 유발하면 안 된다 — 그래서 `useRealtimeStore`(Zustand)가 WebSocket 연결 자체를 소유하고, 컴포넌트는 `useRealtimeStore.subscribe()`로 구독해 `ref`에 최신값만 미러링한다. <br>
반면 과거 히스토리는 사용자가 스크롤할 때만 **요청해서 가져오는(pull)** 데이터라 캐싱·재시도·커서 페이지네이션 같은 요청/응답 생명주기 관리가 필요하고, 이 부분은 TanStack Query의 `useInfiniteQuery`가 정확히 그 문제를 위해 설계된 도구다.

---

## 테스트

```bash
npm run test:e2e       # Playwright — 헤드리스 실행
npm run test:e2e:ui    # Playwright UI 모드
```

WebSocket은 `page.routeWebSocket()`으로 모킹하고, `/api/chat`은 `page.route()`로 모킹해 CI 환경에서 실제 백엔드·OpenAI 없이 완전 격리된 상태로 검증한다.

| TC | 검증 내용 |
|---|---|
| TC-01 | 브라우저 탭 타이틀에 "PulseOps"가 포함된다 |
| TC-02 | 실시간 인프라 메트릭 관제 영역이 화면에 노출된다 |
| TC-03 | AI 챗봇 질문 입력창이 화면에 노출된다 |
| TC-04 | 시스템 로그 터미널이 화면에 노출된다 |
| TC-05 | CPU 99% 메트릭 WebSocket 주입 후 위험도 카드가 `text-red-400` 상태로 변이된다 |
| TC-06 | 로그 WebSocket 주입 후 터미널에 CRITICAL ERROR 패킷이 실시간 인입된다 |
| TC-07 | 메트릭 주입으로 챗봇 활성화 후 AI 분석 답변이 비동기로 렌더링된다 |
| TC-08 | 3개 서버(Seoul Web/DB, Jeju AI)의 메트릭이 동시에 유입돼도 서버별 값이 섞이지 않고 요약 카드에 정확히 반영된다 |
| TC-09 | WebSocket 연결이 서버측에서 끊기면 프론트가 약 2초 후 자동으로 재연결을 시도한다 |
| TC-10 | 히스토리 API가 500 오류를 반환해도 대시보드가 크래시하지 않고 정상적으로 렌더링된다 |

GitHub Actions(`playwright.yml`)가 `main` push/PR마다 이 스위트를 자동 실행한다.

---

## 배포

Vercel — GitHub 연동으로 `main` push 시 자동 배포된다. [suki-pulseops.vercel.app](https://suki-pulseops.vercel.app)

빌드 시 `NEXT_PUBLIC_WS_URL`/`NEXT_PUBLIC_API_URL`을 Render 백엔드 주소로, `OPENAI_API_KEY`를 Vercel 프로젝트 환경 변수로 설정해야 한다.

---

## 세션 작업 로그 / 상세 트러블슈팅

설계 배경과 트러블슈팅 전체 기록은 [docs/](./docs/)에 세션 단위로 남아 있다.

| 세션 | 내용 |
|---|---|
| [Session 1](./docs/SESSION1_WORK_LOG.md) | 프로젝트 초기화, 시뮬레이터 구축, 초기 렌더링 병목 진단 |
| [Session 2](./docs/SESSION2_WORK_LOG.md) | re-render 격리, `useRef` 공유 버퍼 도입 |
| [Session 3](./docs/SESSION3_WORK_LOG.md) | AI 챗봇 서비스 레이어 분리 |
| [Session 4](./docs/SESSION4_WORK_LOG.md) | Playwright E2E 인프라 구축 + CI/CD 파이프라인 (TC-01~07) |
| [Session 5](./docs/SESSION5_WORK_LOG.md) | 차트 시계열 역방향 무한 스크롤 + 실시간 데이터 정밀 병합 아키텍처 |
| [Session 6](./docs/SESSION6_WORK_LOG.md) | 다중 서버 필터링, Y축 LERP 동적 스케일링, 관심사 분리 리팩토링 |
| [Session 7](./docs/SESSION7_WORK_LOG.md) | Supabase Realtime → apps/server WebSocket/REST 전환 (10초 집계 슬롯 버그) |
| [Session 8](./docs/SESSION8_WORK_LOG.md) | WebSocket 단일 연결 통합 (3중 브로드캐스트 트러블슈팅) |

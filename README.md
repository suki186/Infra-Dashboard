# PulseOps

실시간 인프라 모니터링 대시보드 — WebSocket으로 서버 메트릭/로그를 스트리밍하고, AI가 장애를 교차 진단한다.

<img width="1695" height="1198" alt="image" src="https://github.com/user-attachments/assets/07b7534d-ad13-4da8-a4e4-4d5c74336287" />



> **배포:** Render 무료 플랜 특성상 첫 로딩에 최대 1분 소요될 수 있음.  <br> [suki-pulseops.vercel.app](https://suki-pulseops.vercel.app)


---

## 핵심 성과

| 항목 | 내용 |
|---|---|
| WebSocket 트래픽 최적화 | 서버 레벨 전송 주기 제어 + 단일 커넥션 통합으로 Supabase Realtime 대비 **초당 메시지 -31.4%**, **전송 바이트 -83.1%** |
| 실시간 차트 렌더링 | `useRef` 공유 버퍼 + 제로 할당 배열 재사용, 300ms 독립 페인트 루프로 **60fps 유지** |
| E2E 테스트 | Playwright **10개 시나리오**, GitHub Actions로 `main` 병합 전 자동 품질 게이트 |

WebSocket 최적화 수치는 브라우저 Network 탭 HAR 캡처로 실측했다. 세 단계 측정값:

| 지표 | Before (Supabase 직접 구독) | 전환 직후 (연결 3중화) | 최종 (단일 연결) |
|---|---|---|---|
| 초당 메시지 수 | 8.17건 | 16.04건 | **5.60건** |
| 초당 전송 바이트 | 5.22 KB | 2.53 KB | **0.88 KB** |

전환 직후엔 메시지당 크기는 줄었지만 컴포넌트 3곳이 각자 WebSocket을 열어 서버가 같은 메시지를 3중으로 발송하는 바람에 메시지 수가 오히려 늘었던 것을, 연결을 스토어 하나로 통합해 최종적으로 잡았다 — 자세한 원인 분석은 [아래 트러블슈팅](#트러블슈팅-하이라이트) 참고.

---

## 아키텍처 개요

npm workspaces 기반 모노레포. 프론트가 REST로 데이터를 쓰고 WebSocket으로 구독하는 구조를, 프론트/백엔드가 `packages/shared`의 타입 계약으로 묶는다.

```
infra-dashboard/
├── apps/
│   ├── web/       Next.js 프론트엔드 — 대시보드 UI, 실시간 차트, AI 챗봇
│   └── server/    Fastify 백엔드 — WebSocket 브로드캐스트, REST API, DB 액세스
└── packages/
    └── shared/    프론트-백엔드 공유 타입 (WSMessage, ServerMetric, LogEntry)
```

**데이터 흐름**

```
시뮬레이터/데모 생성기
   │  POST /api/metrics, /api/logs
   ▼
apps/server
   ├─ Prisma → PostgreSQL(Supabase)에 영속화
   └─ dataBuffer(serverId별 최신값만 유지) → 1초 주기 브로드캐스터
        │  WSMessage (WSMessage: metrics | log)
        ▼
apps/web (RealtimeSocketProvider → Zustand 스토어, 단일 커넥션)
   ├─ 요약 카드 / 위험도
   ├─ 실시간 차트 (Chart.js, 300ms 페인트 루프)
   └─ 로그 터미널
```

---

## 기술 스택

| 구분 | 기술 |
|---|---|
| 프론트엔드 | ![Next JS](https://img.shields.io/badge/Next.js-black?style=flat-square&logo=next.js&logoColor=white) ![React](https://img.shields.io/badge/React-61DAFB.svg?style=flat-square&logo=React&logoColor=white) ![TypeScript](https://img.shields.io/badge/Typescript-3178C6.svg?style=flat-square&logo=typescript&logoColor=white) ![TailwindCSS](https://img.shields.io/badge/TailwindCSS-06B6D4?style=flat-square&logo=tailwind-css&logoColor=white) ![Chart JS](https://img.shields.io/badge/Chart.js-FF6384?style=flat-square&logo=chartdotjs&logoColor=white) ![React Query](https://img.shields.io/badge/-Tanstack%20Query-FF4154?style=flat-square&logo=react%20query&logoColor=white) ![Zustand](https://img.shields.io/badge/-Zustand-443E39?style=flat-square&logo=React&logoColor=white) |
| 백엔드 | ![Fastify](https://img.shields.io/badge/-Fastify-000000?style=flat-square&logo=fastify&logoColor=white) ![TypeScript](https://img.shields.io/badge/Typescript-3178C6.svg?style=flat-square&logo=typescript&logoColor=white) ![Fastify](https://img.shields.io/badge/-@fastify/websocket-000000?style=flat-square) ![Fastify](https://img.shields.io/badge/-@fastify/cors-000000?style=flat-square) ![Vitest](https://img.shields.io/badge/-Vitest-00FF74?style=flat-square&logo=vitest&logoColor=white) |
| DB | ![PostgreSQL](https://img.shields.io/badge/-PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=flat-square&logo=supabase&logoColor=white) ![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=flat-square&logo=Prisma&logoColor=white) |
| AI(챗봇) | ![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4o--mini-black?style=flat-square&logo=openai&logoColor=white) |
| 테스트/CI | ![Playwright](https://img.shields.io/badge/-Playwright-45ba4b?style=flat-square) ![Actions](https://img.shields.io/badge/-Github_Actions-2088FF?style=flat-square&logo=githubactions&logoColor=white) |
| 인프라 | ![Vercel](https://img.shields.io/badge/-Vercel-000000?style=flat-square&logo=vercel&logoColor=white) ![Render](https://img.shields.io/badge/-Render-000000?style=flat-square&logo=render&logoColor=white) |
| 개발 도구 | ![Claude](https://img.shields.io/badge/-Claude%20Code-D97757?style=flat-square&logo=claudecode&logoColor=white) |

- 차트는 `chart.js` 코어를 `useRef` 캔버스에 직접 그리는 imperative 방식이다. React 상태를 거치지 않아야 300ms 페인트 루프에서 리렌더가 발생하지 않기 때문에 의도적으로 React 래퍼를 배제했다.
- PostgreSQL을 Supabase의 관리형 인프라에 올려두고 `apps/server`가 Prisma로 직접 접속한다. 초기에는 `apps/web`이 Supabase Realtime을 직접 구독했지만, 자체 Fastify WebSocket 서버로 전환하며 그 경로는 걷어냈다.

---

## 폴더 구조

```
apps/
├── web/
│   ├── app/            Next.js App Router 라우트
│   ├── src/
│   │   ├── components/ 대시보드 UI 컴포넌트
│   │   ├── hooks/      useChartPaint, useMetricsHistory 등
│   │   ├── store/      Zustand 실시간 스토어 (WebSocket 단일 연결 소유)
│   │   ├── services/   API 클라이언트
│   │   ├── config/     서버 목록·색상 등 상수
│   │   └── types/      로컬 타입
│   ├── scripts/        simulator.mjs — 가상 메트릭/로그 생성기
│   ├── tests/          Playwright E2E
│   └── docs/           세션별 작업 로그
└── server/
    ├── src/
    │   ├── routes/     REST 라우트 (metrics, logs, history, health)
    │   ├── ws/          연결 관리 / 데이터 버퍼 / 브로드캐스터
    │   ├── db/          Prisma 클라이언트
    │   └── demo/        배포 환경용 데모 데이터 생성기 + retention
    ├── prisma/          schema.prisma
    └── docs/            세션별 작업 로그

packages/
└── shared/
    └── src/             WSMessage 등 공유 타입
```

---

## 앱별 상세 문서

- [apps/web/README.md](./apps/web/README.md) — 프론트엔드 아키텍처, 렌더링 최적화 상세
- [apps/server/README.md](./apps/server/README.md) — API 계약, 폴더 구조, 환경 변수

세션 단위 작업 로그(설계 의도, 트러블슈팅 전체 기록)는 [apps/web/docs](./apps/web/docs/), [apps/server/docs](./apps/server/docs/)에 있다.

---

## 트러블슈팅 하이라이트

### WebSocket 3중 브로드캐스트 — 연결 통합 전까지 메시지 수가 오히려 늘었던 문제

Supabase Realtime에서 자체 WebSocket 서버로 전환한 직후 재측정했을 때, 전송 바이트는 줄었는데 초당 메시지 수는 8.17건 → 16.04건으로 오히려 늘어 있었다. 원인은 `page.tsx`, `LogTerminal`, `useChartPaint` 세 곳이 각자 독립적으로 WebSocket을 열고 있었던 것 — 서버가 채널 구독 개념 없이 연결된 모든 클라이언트에 전체 데이터를 그대로 흘려보내는 구조라, 연결이 3개면 같은 메시지가 3배로 중복 발송됐다. `useRealtimeStore`(Zustand)가 연결 자체를 앱 전체에서 하나만 소유하도록 구조를 바꿔, 최종적으로 Before 대비 메시지 수 -31.4% / 바이트 -83.1%를 달성했다. 메시지 크기 최적화만으로는 부족했고, 연결 토폴로지 자체가 더 큰 지렛대였다는 게 핵심 교훈이다.
→ [apps/web/docs/SESSION8_WORK_LOG.md](./apps/web/docs/SESSION8_WORK_LOG.md)

### 10초 집계 슬롯 버그 — 데이터는 도착하는데 차트만 멈춰 보인 문제

같은 WebSocket 전환 작업 직후, 로그 터미널은 매초 갱신되는데 실시간 차트만 5초 넘게 멈춰있다가 한 번에 점프하는 현상이 있었다. 콜백 로그로 파이프라인을 단계별로 추적한 결과 WebSocket 수신 자체는 정상이었고, 차트가 거치는 별도의 10초 단위 집계 버킷(`SLOT_MS = 10_000`)이 원인이었다 — 이 로직은 서버가 초당 1회로 브로드캐스트 주기를 바꾼 뒤에도 예전 폭(10초) 그대로 남아 있었다. 슬롯 폭을 1초로 맞춰 해결했다. "데이터가 도착하는가"와 "화면에 반영되는 주기"는 완전히 다른 계층이라 따로 추적해야 한다는 사례.
→ [apps/web/docs/SESSION7_WORK_LOG.md](./apps/web/docs/SESSION7_WORK_LOG.md)

---

## 로컬 실행

### 1. 클론 및 의존성 설치

```bash
git clone <repo-url>
cd infra-dashboard
npm install
```

npm workspaces 모노레포이므로 루트에서 한 번만 설치하면 `apps/web`, `apps/server`, `packages/shared` 의존성이 모두 연결된다.

### 2. 환경 변수 설정

Postgres DB가 필요하다(Supabase 권장 — Transaction/Session 풀러 URL을 분리해서 쓴다). `apps/server/.env.example`, `apps/web/.env.example`을 참고해 각각 `.env`를 만든다.

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

- `apps/server/.env` — `DATABASE_URL`(6543, transaction pooler), `DIRECT_URL`(5432, session pooler) 필수. `DEMO_MODE=true`로 두면 시뮬레이터 없이 서버가 자체적으로 데모 데이터를 생성한다.
- `apps/web/.env` — `NEXT_PUBLIC_WS_URL`/`NEXT_PUBLIC_API_URL`은 기본값이 로컬 서버(`localhost:3001`)를 가리키므로 로컬 실행 시 수정 불필요. AI 챗봇을 쓰려면 `OPENAI_API_KEY` 필요.

DB에 테이블이 없다면 Prisma 스키마를 그대로 반영한다.

```bash
npx prisma db push --schema=apps/server/prisma/schema.prisma
```

### 3. 개발 서버 실행

```bash
npm run dev:server   # Fastify — http://localhost:3001
npm run dev:web       # Next.js — http://localhost:3000
```

### 4. (선택) 가상 데이터 시뮬레이터

`DEMO_MODE`를 켜지 않았다면, 별도 터미널에서 시뮬레이터를 돌려야 대시보드에 데이터가 흐른다.

```bash
npm run simulate --workspace=apps/web
```

### 5. 테스트

```bash
npm test --workspace=apps/server   # Vitest
npm run test:web                    # Playwright E2E
```


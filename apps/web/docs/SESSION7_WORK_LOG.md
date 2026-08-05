# Session 7 Work Log — 프론트/시뮬레이터를 Node.js 백엔드로 전환

---

## 목차

1. [세션 개요](#overview)
2. [구현 내역](#implementation)
3. [핵심 트러블슈팅 케이스 스터디 — 10초 단위 집계 슬롯 버그](#troubleshooting)
4. [검증 결과](#verify)
5. [핵심 인사이트](#insight)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

`apps/server` 쪽에서는 Session 1~4([apps/server/docs](../../server/docs/))를 통해 WebSocket 서버(`/ws`), REST 수집 라우트(`POST /api/metrics`, `/api/logs`), 과거 데이터 조회(`GET /api/metrics/history`, `/api/logs/history`), 그리고 서버 레벨 전송 주기 제어(`BROADCAST_INTERVAL_MS`)까지 완성된 상태였다. 특히 [Session 4](../../server/docs/SESSION4_WORK_LOG.md)에서는 `apps/web`이 아직 새 백엔드로 전환되기 전 Supabase Realtime 구조의 Before 베이스라인(초당 8.17건 / 5.22KB)까지 미리 측정해두고, "`apps/web`이 새 WebSocket 서버를 실제로 소비하도록 전환된 후 재측정해 비교할 예정"이라는 과제를 남겨두었다.

이번 세션 시작 시점까지 `apps/web`은 여전히 Supabase Realtime을 직접 구독하고 있었다 — 백엔드가 완성돼 있어도 프론트가 그것을 쓰지 않으면 아무 의미가 없는 상태였다. 이번 세션의 목표는 그 간극을 메우는 것, 즉 **프론트/시뮬레이터가 Supabase Realtime 의존을 완전히 걷어내고 `apps/server`가 제공하는 WebSocket/REST 인터페이스로 전환하는 것**이다.

### 이번 세션 범위

| 파일 | 역할 |
|---|---|
| `src/hooks/useServerSocket.ts` | 신규 — `/ws` 구독 및 재연결을 담당하는 공용 훅 |
| `app/page.tsx` | 요약 카드용 메트릭 구독을 Supabase → 새 훅으로 교체 |
| `src/components/dashboard/LogTerminal.tsx` | 로그 스트리밍 구독을 Supabase → 새 훅으로 교체 |
| `src/hooks/useChartPaint.ts` | 차트용 메트릭 구독을 Supabase → 새 훅으로 교체 |
| `src/store/useRealtimeStore.ts` | 실시간 슬롯 집계 스토어 — 이번 세션 트러블슈팅 대상 |
| `scripts/simulator.mjs` | Supabase `insert()` → `apps/server` REST POST 전환 |

---

<a id="implementation"></a>
## 2. 구현 내역

### 2-1. 기존 Supabase Realtime 구독 코드 조사

`postgres_changes` / `.channel()` / `.subscribe()` 패턴으로 전수 조사한 결과, 실시간 데이터를 실제로 구독하는 지점은 3곳이었다.

| 파일 | 채널명 | 구독 대상 | 용도 |
|---|---|---|---|
| `app/page.tsx` | `infrastructure_metrics_feed` | `postgres_changes` INSERT on `infrastructure_metrics` | `MetricsMap` 상태 갱신 → 요약 카드(서버 수/평균 CPU/위험도) |
| `LogTerminal.tsx` | `infrastructure_logs_feed` | `postgres_changes` INSERT on `infrastructure_logs` | 로그 터미널 스트리밍 |
| `useChartPaint.ts` | `realtime_chart_feed` | `postgres_changes` INSERT on `infrastructure_metrics` (`MOCK_MODE=false`일 때만) | Zustand `useRealtimeStore`에 ingest |

`SupabaseConnectionTest.tsx`도 `supabase` 클라이언트를 import하고 있었지만 `supabase.auth.getSession()`만 호출할 뿐 위 패턴과 무관했고, 어디서도 import되지 않는 죽은 코드였다 — 조사 범위에는 포함했지만 전환 대상에서는 제외했다.

### 2-2. `useServerSocket.ts` 신규 구현

세 구독 지점을 각각 별도 코드로 교체하는 대신, 공용 훅 하나로 추출했다.

```ts
// src/hooks/useServerSocket.ts
export function useServerSocket({ onMetric, onLog, enabled = true }: UseServerSocketOptions): void {
  const onMetricRef = useRef(onMetric)
  const onLogRef = useRef(onLog)
  useEffect(() => {          // 콜백 미러링은 반드시 커밋 단계(useEffect)에서
    onMetricRef.current = onMetric
    onLogRef.current = onLog
  })

  useEffect(() => {
    if (!enabled) return
    const url = process.env.NEXT_PUBLIC_WS_URL ?? DEFAULT_WS_URL
    // ... WebSocket 연결, WSMessage 파싱, close 시 2초 후 재연결
  }, [enabled])
}
```

- `ws://localhost:3001/ws`(`NEXT_PUBLIC_WS_URL`로 오버라이드 가능)에 연결하고, `@infra-dashboard/shared`의 `WSMessage` 타입으로 메시지를 파싱해 `type`이 `'metrics'`/`'log'`인지에 따라 `onMetric`/`onLog` 콜백을 호출한다.
- 연결이 끊기면 2초 후 자동 재연결한다.
- `enabled` 옵션을 추가해 `useChartPaint.ts`의 `MOCK_MODE` 분기에서 연결 자체를 열지 않을 수 있게 했다.
- 콜백을 `ref`로 미러링해 재연결 없이 항상 최신 콜백을 참조하게 하는 것은 기존 코드베이스(`useChartPaint.ts`의 `visibleServersRef` 패턴)와 동일한 관용구다. 다만 이 대입을 렌더 바디에서 바로 하면 React 19.2에서 "Cannot access refs during render" 런타임 에러가 발생해, 의존성 배열 없는 `useEffect`(매 렌더 후 실행)로 옮겨 커밋 단계에서만 쓰도록 했다.

### 2-3. 3개 컴포넌트 교체 — 독립 채널 구조 유지 + 타입 변환

`app/page.tsx`, `LogTerminal.tsx`, `useChartPaint.ts` 세 곳 모두 기존처럼 **각자 독립적으로** `useServerSocket`을 호출하도록 교체했다. 세 컴포넌트가 하나의 공유 커넥션을 나눠 쓰는 구조로 합치지 않은 이유는, 기존 Supabase 구조가 이미 "컴포넌트별 독립 채널 구독"이었고 이번 세션의 목표는 데이터 소스 교체이지 구독 구조 재설계가 아니었기 때문이다. 그 결과 브라우저는 여전히 WebSocket 연결을 3개 연다.

타입 변환이 필요했던 이유는 `packages/shared`의 `WSMessage`/`ServerMetric`/`LogEntry`가 Prisma 스키마를 따라 camelCase(`serverId`, `cpuUsage`, `memoryUsage`, `diskIo`)인 반면, `apps/web`의 기존 로컬 타입(`config/infrastructure.ts`의 `ServerMetric`, `types/terminal.ts`의 `LogEntry`)은 처음부터 snake_case로 설계돼 있었기 때문이다. 기존 상태 관리 구조(`useState`, `MetricsMap`, `logsRef` 배열)를 그대로 유지하는 쪽을 택했으므로, 변환은 각 훅 호출부의 콜백 안에서만 처리했다.

```ts
// app/page.tsx
onMetric: (metric) => {
  setMetrics(prev => ({
    ...prev,
    [metric.serverId]: {
      server_id: metric.serverId, status: metric.status,
      cpu_usage: metric.cpuUsage, memory_usage: metric.memoryUsage, disk_io: metric.diskIo,
    },
  }))
}
```

`LogTerminal.tsx`는 한 가지 추가 문제가 있었다 — 브로드캐스트되는 `LogEntry`(`shared`)에는 `id` 필드가 없다(서버가 로그에 auto-increment ID를 실어 보내지 않음). 기존 로컬 `LogEntry` 타입은 React 리스트 key로 `id: number`를 요구했으므로, 클라이언트 측에서 `nextIdRef` 증가 카운터로 채번하도록 했다.

### 2-4. `scripts/simulator.mjs` — REST API 전환

`@supabase/supabase-js`와 `createClient()` 초기화를 제거하고, `fetch`로 `apps/server`의 `POST /api/metrics` / `POST /api/logs`를 호출하도록 바꿨다. 서버 URL은 `SERVER_URL` 환경변수(기본값 `http://localhost:3001`)로 구성 가능하다.

기존 Supabase `.insert(rows)`는 배열을 한 번에 저장할 수 있었지만, `apps/server`의 두 라우트는 단건 payload만 받으므로(`isValidMetricBody`/`isValidLogBody`가 객체 하나를 검증) 서버 3대·로그 N줄을 각각 개별 POST로 보내도록 바꾸고 `Promise.allSettled`로 묶어 한쪽 실패가 나머지 전송을 막지 않게 했다. STRESS(T+20s)/OFFLINE(T+40s)/RECOVERY(T+60s) 장애 주입 스케줄과 콘솔 출력 포맷은 그대로 유지했다.

---

<a id="troubleshooting"></a>
## 3. 핵심 트러블슈팅 케이스 스터디 — 10초 단위 집계 슬롯 버그

### 증상

전환 작업을 마친 뒤 화면을 녹화해보니, 로그 터미널은 매초 정상적으로 새 줄이 찍히는데 **실시간 차트만 5초 이상 완전히 동일한 모양으로 멈춰있다가 한참 뒤에 갑자기 크게 점프**하는 현상이 관찰됐다.

### 원인 분석 과정

같은 세션에서 만든 `useServerSocket`이 세 곳에서 다르게 동작할 이유가 없어 보였으므로, 파이프라인을 단계별로 분리해서 임시 로그로 추적했다.

1. **`useChartPaint.ts`의 훅 사용법 자체를 `page.tsx`/`LogTerminal.tsx`와 대조** — `enabled: !MOCK_MODE`, `onMetric` 콜백 시그니처 모두 동일한 패턴이었고, `MOCK_MODE` 상수도 이미 `false`라 실시간 구독을 막고 있지 않았다. 차이 없음.
2. **`onMetric` 콜백에 임시 `console.log` 추가** — 서버 3대 각각 정확히 ~1초 간격으로 호출되고 있었다. WebSocket 수신 자체는 정상.
3. **`useRealtimeStore.ts`의 `ingest()`에 임시 로그 추가** — 매 호출마다 실행은 되지만, `floorToSlotISO()`가 `SLOT_MS = 10_000`(10초 단위)으로 타임스탬프를 버림. 로그를 보면 9~10번의 연속 `ingest` 호출이 전부 `UPDATE existing slot`이었고, 10초 경계를 넘는 순간에만 `NEW slot`이 한 번 찍혔다.
4. **페인트 타이머(300ms)에 `combined.length` 변화 로그 추가** — 타이머 자체는 300ms마다 정상적으로 돌고 있었지만, x축 컬럼 수(`combined.length`)가 10초에 딱 한 번만 증가했다. 즉 페인트 루프는 멈추지 않았는데, 그릴 새 데이터(새 컬럼)가 10초에 한 번만 생겼던 것이다.

`LogTerminal.tsx`는 이런 집계 단계가 아예 없다 — 로그 1건이 도착하면 버킷 없이 바로 배열에 `push`하고 `setTick`으로 리렌더를 트리거하므로 매초 갱신되어 보였다. 반면 차트는 `useRealtimeStore`라는 **10초 폭 집계 계층**을 하나 더 거치기 때문에, 같은 WebSocket 파이프라인을 쓰면서도 시각적 갱신 주기가 완전히 달랐다. 이 10초 슬롯 로직 자체는 이번 WebSocket 전환과 무관하게 이전 세션부터 있던 코드였고, Supabase Realtime 시절에도 동일하게 존재했을 결함이었다.

### 해결

`apps/server`의 실제 브로드캐스트 주기(서버당 ~1초)에 슬롯 폭을 맞췄다.

```ts
// src/store/useRealtimeStore.ts

// Before
const MAX_SLOTS = 300   // 50분치 (10초 × 300)
const SLOT_MS   = 10_000

// After
const MAX_SLOTS = 300   // 5분치 (1초 × 300)
const SLOT_MS   = 1_000
```

`MAX_SLOTS`를 그대로 300으로 두었기 때문에 라이브 버퍼가 담는 실제 시간 폭은 50분 → 5분으로 줄었다. 다만 그보다 오래된 구간은 애초에 `useMetricsHistory` 훅의 `/api/metrics/history` 무한 스크롤이 별도로 커버하는 영역이라, 라이브 버퍼 축소가 기능 손실로 이어지지는 않는다고 판단했다.

---

<a id="verify"></a>
## 4. 검증 결과

- `npm run dev:server` + `npm run dev:web` + 수정된 `simulator.mjs`를 동시 실행한 뒤 브라우저 콘솔을 확인한 결과, `📡 WebSocket 서버 연결 성공!` 로그가 **3회** 출력됐다 — `page.tsx`/`LogTerminal.tsx`/`useChartPaint.ts` 세 곳이 의도대로 각자 독립 연결을 여는 구조가 실제로 동작함을 확인.
- `GET /api/metrics/history`, `GET /api/logs/history`로 조회했을 때 시뮬레이터가 보낸 데이터가 실제로 DB에 적재되어 있음을 확인.
- `SLOT_MS` 수정 후, 차트 wrapper의 렌더링 폭을 500ms 간격으로 12초간 샘플링한 결과 `PX_PER_SLOT`(40px)만큼 거의 매초 증가했다 (예: `4120 → 4160 → 4200 → … → 4560`, 12초간 11회 증가) — 더 이상 9초 동안 멈췄다가 한 번에 뛰는 패턴이 아니라 초 단위로 고르게 컬럼이 추가됨을 수치로 확인.
- 화면 녹화로 차트가 매초 새 포인트를 찍으며 부드럽게 우측으로 흘러가는 것을 최종 확인했다.
- 진단에 사용한 임시 `console.log`와 검증용으로 띄운 서버/웹/시뮬레이터 프로세스는 모두 원상 복구·종료했다.

---

<a id="insight"></a>
## 5. 핵심 인사이트

**데이터가 도착하는가**(네트워크/구독 계층)와 **화면에 반영되는 주기**(집계/렌더 계층)는 완전히 별개이며, 둘을 분리해서 각각 로그로 추적하지 않으면 "WebSocket이 안 되나 보다"처럼 엉뚱한 계층을 의심하게 된다. 이번 케이스에서도 실제로 깨져 있던 것은 연결이 아니라, 훨씬 안쪽에 있던 10초 폭 집계 버킷이었다.

# Session 4 Work Log — WebSocket 서버 및 서버 레벨 전송 주기 제어 구현

---

## 목차


1. [세션 개요](#overview)
2. [TDD 진행 방식 — vitest 도입](#tdd)
3. [구현 내역](#implementation)
4. [핵심 트러블슈팅 케이스 스터디](#troubleshooting)
5. [검증 결과](#verify)
6. [Before 베이스라인](#baseline)

---

<a  id="overview"></a>

## 1. 세션 개요

### 배경

- 기존 구조: `apps/web`이 Supabase Realtime을 직접 구독 → DB에 INSERT되는 즉시, 구독 중인 모든 클라이언트에게 그대로 브로드캐스트.
- 문제: 수신 빈도를 클라이언트가 통제할 수 없고, 네트워크에는 이미 다 도착한 뒤라 프론트 스로틀링으로는 대역폭 낭비를 막지 못함

  
### 목표
  
서버가 들어오는 데이터를 메모리에 **최신값으로만** 유지하고, 별도로 정한 주기(`BROADCAST_INTERVAL_MS`)마다만 클라이언트에 내려준다 — **데이터 발생 빈도와 전송 빈도의 분리**.

  
### 이번 세션 범위

| 파일 | 역할 |
|---|---|
| `src/ws/connectionManager.ts` | WebSocket 클라이언트 연결/해제 관리 |
| `src/ws/dataBuffer.ts` | serverId별 최신 메트릭/로그만 유지 |
| `src/ws/broadcaster.ts` | 주기적 브로드캐스터 |
| `src/routes/metrics.ts`, `logs.ts` | 데이터 수집 POST 라우트 |
| `src/routes/history.ts` | 과거 데이터 조회 GET 라우트 |
| `server.ts` | 위 계층 전체 등록 |

---

<a  id="tdd"></a>

## 2. TDD 진행 방식 — vitest 도입

-  **트랜스파일 불필요**: `ts-node`처럼 esbuild가 `.ts`를 즉시 실행.
-  **`@fastify/websocket`과 궁합**: 공식 지원 테스트 방법인 `fastify.injectWS()`가 실제 서버 기동 없이 핸드셰이크를 시뮬레이션.
-  `vitest.config.mts`(확장자 `.mts`): `package.json`에 `"type": "module"`이 없어 `.ts`로 두면 CJS 로드 경고가 뜨는 것을 피함.

---

<a  id="implementation"></a>

## 3. 구현 내역

### `connectionManager.ts`

연결된 클라이언트를 `Set`으로 관리한다. `addClient`가 소켓의 `close` 이벤트에 자기 자신을 지우는 리스너를 `once`로 등록해, 별도 해제 호출 없이 연결 종료 시 자동 정리된다.

### `dataBuffer.ts`

`serverId`를 키로 하는 `Map`에 값을 저장 — 같은 서버에서 여러 번 값이 들어와도 덮어써져 항상 최신 값만 남는다. `flushMetrics`/`flushLogs`는 쌓인 값을 반환하며 동시에 버퍼를 비운다("읽으면서 비우기"). 즉시 브로드캐스트하지 않는 이유는 도착 빈도와 전송 빈도를 분리하기 위함이다.

### `broadcaster.ts`

```typescript

const  timer = setInterval(() =>  {
  for (const  metric  of dataBuffer.flushMetrics()) broadcast({ type:  'metrics', payload: metric });
  for (const  log  of dataBuffer.flushLogs()) broadcast({ type:  'log', payload: log });
}, intervalMs ?? Number(process.env.BROADCAST_INTERVAL_MS) || 1000);

```

- 기본 주기 1000ms, `BROADCAST_INTERVAL_MS`로 조절.
-  `intervalMs`를 테스트에서 주입 가능하게 열어둔 것은 `vi.useFakeTimers()` + 짧은 주기(250ms)로 타이머 동작을 검증하기 위함.
- 두 틱 사이 새 데이터가 없으면 그 틱엔 아무것도 안 보낸다 — "무전송" 동작도 별도 테스트로 고정.
-  `client.readyState === OPEN` 체크로 끊긴 소켓에 `send()` 호출하는 것을 방지.

### `routes/metrics.ts`, `routes/logs.ts`

-  `createdAt`은 클라이언트 값이 아니라 서버가 요청 수신 시점에 직접 생성 — dataBuffer와 DB에 같은 값이 들어가야 브로드캐스트 값과 history 조회 값이 어긋나지 않는다.
-  `dataBuffer.setMetric()`을 DB 저장보다 먼저 호출 — DB 쓰기가 지연돼도 브로드캐스트 대기열엔 즉시 반영.
- 유효성 검사 실패 시 `400`.

### `routes/history.ts`

-  `limit` 기본 50, 최대 500 캡.
- Prisma의 `id: BigInt` → `String(id)`, `createdAt: Date` → `toISOString()` 변환 (BigInt는 `JSON.stringify`가 기본적으로 못 다룸).
-  `/api/metrics/history`, `/api/logs/history` 동일한 페이지네이션 로직 반복.

---

<a  id="troubleshooting"></a>

## 4. 핵심 트러블슈팅 케이스 스터디

### Case 1: `@fastify/websocket` 등록 순서 — `socket.once is not a function`

**증상**: 실제 WebSocket 연결 시 핸드셰이크가 500으로 실패. `connectionManager.test.ts`(`injectWS()` 사용)는 통과하는데 실서버는 실패.
**원인**: `addClient`가 받은 `socket`을 찍어보니 `WebSocket`이 아니라 Fastify `Request` 객체였다. `@fastify/websocket`은 `onRoute` 훅으로 `{websocket:true}` 라우트를 가로채는데, 이 훅은 `register()`가 실제로 완료돼야 붙는다.

```typescript

// Before — register()를 기다리지 않고 바로 라우트 등록
app.register(websocketPlugin);
app.get('/ws', { websocket:  true  }, createConnectionHandler(connectionManager));

```

  

`register()`는 즉시 반환되고 로딩은 나중에 예약될 뿐이라, 같은 동기 블록에서 바로 `.get()`을 부르면 그 시점엔 훅이 없다 → `/ws`가 평범한 라우트로 등록되어 표준 시그니처 `(request, reply)`로 호출됨. 테스트는 `await app.register(...)`로 기다렸기 때문에 경합이 드러나지 않았다.

**해결**: `server.ts`를 `async main()`으로 재구성해 등록 순서를 강제.

```typescript

// After
async  function  main(): Promise<void> {
  await app.register(websocketPlugin);
  app.get('/ws', { websocket:  true }, createConnectionHandler(connectionManager));
  await app.register(registerMetricsRoutes({ dataBuffer, prisma }));
  // ...
  await app.listen({ port:  PORT, host:  HOST });
}

```

---

<a  id="verify"></a>

## 5. 검증 결과

**자동 테스트/빌드**

```

$ npm test --workspace=apps/server → 6 files / 23 tests 통과
$ npm run build --workspace=apps/server → 에러 없음

```


**REST 라우트 (curl)**: `POST /api/metrics`, `POST /api/logs` 정상 저장 + `201` 응답, 누락 필드는 `400`, `GET /api/metrics/history`로 저장값 재조회 확인 

**전송 주기 제어 (`scripts/ws-verify.mjs`)**: `/api/metrics`에 300ms마다 POST하면서 `/ws`로 수신 간격 측정.

첫 메시지 외엔 `BROADCAST_INTERVAL_MS`(기본 1000ms)에 정확히 수렴 — POST는 300ms마다 갔지만 수신은 1/3 수준(초당 1건)으로, "서버가 전송 주기를 통제한다"는 목표가 실제 트래픽으로 증명됐다.

---

<a  id="baseline"></a>

## 6. Before 베이스라인

5단계(`broadcaster.ts`) 착수 전, 이후 전환 효과를 비교하기 위해 기존 Supabase Realtime 구조를 Chrome DevTools로 측정해두었다. `apps/web`이 아직 새 WebSocket 서버로 전환되기 전 기준선이다.

| 측정 항목 | 값 |
| --- | --- |
| 측정 구간 | 61.4초 |
| 수신 메시지 수 | 502건 (초당 8.17건) |
| 수신 총량 | 320.9KB (초당 5.22KB) |
| Performance 60초 — Scripting / Rendering / Painting / Total | 7366ms / 433ms / 184ms / 60526ms |

같은 메트릭이 `realtime_chart_feed`(`useChartPaint.ts`)와 `infrastructure_metrics_feed`(`page.tsx`) 두 채널에 각각 183건씩 중복 브로드캐스트되는 비효율도 확인됐다 — 같은 테이블을 두 채널이 독립 구독해 한 번의 INSERT가 두 번 도착하는 구조.

`apps/web`이 이번 세션의 WebSocket 서버를 실제로 소비하도록 전환된 후 동일한 방법으로 재측정해 Before/After로 비교할 예정이다.

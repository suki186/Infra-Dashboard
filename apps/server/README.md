# apps/server

Fastify 기반 실시간 API 서버. 메트릭/로그를 REST로 수집해 Postgres에 영속화하는 동시에, **서버가 데이터 발생 빈도와 무관하게 고정 주기로 WebSocket 브로드캐스트를 제어**한다 — 클라이언트가 몇 번 데이터를 보내든, 전송은 항상 `BROADCAST_INTERVAL_MS` 간격으로만 나간다.

프론트엔드는 [apps/web](../web), 두 워크스페이스가 공유하는 타입은 [packages/shared](../../packages/shared) 참고.

---

## 기술 스택

| 분류 | 기술 |
|---|---|
| 웹 프레임워크 | Fastify 5 |
| 언어 | TypeScript 5 |
| WebSocket | `@fastify/websocket` |
| ORM | Prisma 6 |
| DB | PostgreSQL |
| 테스트 | Vitest + `fastify.injectWS()` (실제 서버 기동 없이 핸드셰이크 시뮬레이션) |

---

## 폴더 구조

```
src/
├── server.ts               진입점 — CORS/WebSocket 플러그인 등록 → 라우트 등록 → listen (순서 중요, 아래 아키텍처 참고)
├── routes/
│   ├── health.ts            GET /health, /health/db
│   ├── metrics.ts           POST /api/metrics
│   ├── logs.ts               POST /api/logs
│   └── history.ts            GET /api/metrics/history, /api/logs/history
├── ws/
│   ├── connectionManager.ts  연결된 WebSocket 클라이언트를 Set으로 관리
│   ├── dataBuffer.ts          serverId를 키로 최신 메트릭/로그만 유지하는 Map
│   └── broadcaster.ts         고정 주기로 dataBuffer를 flush해 브로드캐스트하는 타이머
├── db/
│   └── client.ts              Prisma Client 싱글턴 (globalThis 캐싱으로 개발 중 hot-reload 시 커넥션 누적 방지)
└── demo/
    ├── simulator.ts           DEMO_MODE용 자체 데이터 생성기
    └── retention.ts           DEMO_MODE 데이터 주기적 삭제 스케줄러

prisma/
└── schema.prisma              InfrastructureMetric / InfrastructureLog — `prisma db pull`로 기존 Supabase 테이블을 introspect한 결과물
```

각 모듈에는 같은 디렉터리에 대응하는 `*.test.ts`가 있다(예: `ws/broadcaster.test.ts`).

---

## 환경 변수

`.env.example` 기준.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | (필수) | Postgres 커넥션. **Transaction 모드 풀러(포트 6543)**를 쓴다 — Fastify가 요청마다 짧게 맺고 끊는 커넥션 패턴에 맞는 stateless 모드 |
| `DIRECT_URL` | (필수) | Postgres 커넥션. **Session 모드 풀러(포트 5432)**를 쓴다 — `prisma db pull`/`db push`처럼 세션 상태가 필요한 스키마 작업 전용 |
| `PORT` | `3001` | Fastify가 바인딩할 포트 |
| `ALLOWED_ORIGIN` | — | CORS 허용 origin 추가 목록(콤마 구분). `http://localhost:3000`은 코드에 하드코딩되어 항상 허용되므로 별도 설정 불필요 |
| `BROADCAST_INTERVAL_MS` | `1000` | WebSocket 브로드캐스트 주기(ms). 이 값이 커질수록 전송량은 줄지만 클라이언트 갱신은 느려짐 |
| `DEMO_MODE` | `false` | `true`면 `demo/simulator.ts`가 자체적으로 가상 메트릭/로그를 생성해 채운다. 배포 환경(Render)처럼 `apps/web/scripts/simulator.mjs`를 별도로 띄울 수 없는 곳에서 사용 |
| `DATA_RETENTION_HOURS` | `24` | `DEMO_MODE=true`일 때만 동작. 이 시간(시간 단위)보다 오래된 row를 10분마다 삭제해 무료 DB 티어 용량이 무한정 늘어나는 것을 방지 |

---

## 로컬 실행

루트에서 `npm install`을 마쳤다는 전제로:

```bash
cp apps/server/.env.example apps/server/.env   # DATABASE_URL / DIRECT_URL 채우기
npx prisma db push --schema=apps/server/prisma/schema.prisma   # 테이블 없는 새 DB라면
npm run dev:server                              # 루트에서, http://localhost:3001
```

기본값(`DEMO_MODE=false`)으로는 서버 혼자 데이터를 만들지 않는다. 둘 중 하나를 선택한다.

- **시뮬레이터 사용** (`apps/web/scripts/simulator.mjs`가 실제로 `POST /api/metrics`·`/api/logs`를 호출하는 걸 보고 싶을 때): `.env`는 그대로 두고, 별도 터미널에서 `npm run simulate --workspace=apps/web` 실행.
- **DEMO_MODE 사용** (프론트만 붙여보고 싶을 때): `.env`에 `DEMO_MODE=true` 추가 후 서버 재시작 — 별도 프로세스 없이 서버 자체가 데이터를 생성한다.

`curl http://localhost:3001/health` → `{"status":"ok"}`면 정상 기동이다.

---

## API 엔드포인트

### REST

| Method | Path | 역할 |
|---|---|---|
| GET | `/health` | 프로세스 기동 확인. DB를 조회하지 않는다 |
| GET | `/health/db` | DB 연결 확인 — `infrastructure_metrics` row count를 반환. 실패 시 500 |
| POST | `/api/metrics` | 메트릭 1건 수집 → `dataBuffer` 반영 + DB 저장. 성공 201, 유효성 검사 실패 400 |
| POST | `/api/logs` | 로그 1건 수집 → `dataBuffer` 반영 + DB 저장. 성공 201, 유효성 검사 실패 400 |
| GET | `/api/metrics/history` | 메트릭 페이지네이션 조회 (`limit` 기본 50·최대 500, `page`, `serverId` 선택) |
| GET | `/api/logs/history` | 로그 페이지네이션 조회 (파라미터 동일) |

두 POST 라우트 모두 `createdAt`은 클라이언트가 보낸 값을 쓰지 않고 서버가 요청 수신 시점에 직접 생성한다 — `dataBuffer`(브로드캐스트용)와 DB(히스토리 조회용)에 같은 타임스탬프가 들어가야 두 경로의 값이 어긋나지 않기 때문이다.

### WebSocket

| Path | 역할 |
|---|---|
| `/ws` | 연결하면 클라이언트로 등록. 채널/구독 개념 없이 연결된 모든 클라이언트에 동일한 `WSMessage`를 `BROADCAST_INTERVAL_MS` 주기로 전송 |

```ts
type WSMessage =
  | { type: 'metrics'; payload: ServerMetric }
  | { type: 'log'; payload: LogEntry }
```

타입 정의는 [`packages/shared`](../../packages/shared)에 있다.

---

## 아키텍처 — 서버 레벨 전송 주기 제어

핵심은 **데이터가 도착하는 빈도**(REST POST 호출마다, 불규칙)와 **클라이언트로 나가는 빈도**(고정 인터벌)를 분리하는 것이다. `connectionManager` / `dataBuffer` / `broadcaster` 세 모듈이 각자 다른 축을 담당한다.

```
[연결 관리]
클라이언트가 /ws로 연결
      │
      ▼
connectionManager.addClient(socket)     Set<WebSocket>에 등록
      │                                 socket의 'close' 이벤트에 once 리스너 등록
      ▼                                 → 연결 종료 시 별도 해제 호출 없이 자동으로 Set에서 제거
(연결 유지, getClients()로 언제든 스냅샷 조회 가능)


[데이터 도착 — 불규칙한 빈도]
POST /api/metrics, /api/logs
      │
      ├──▶ dataBuffer.setMetric() / setLog()   serverId를 키로 Map에 최신값만 덮어쓰기
      │                                         (같은 서버에서 여러 번 와도 마지막 값만 남음)
      │
      └──▶ prisma.create()                     DB에 영속화 (dataBuffer 반영이 먼저 — DB 쓰기가
                                                 지연돼도 브로드캐스트 대기열엔 즉시 반영되도록)


[브로드캐스트 — 고정 주기]
broadcaster: setInterval(tick, BROADCAST_INTERVAL_MS)   기본 1000ms
      │
      ▼  매 tick마다
dataBuffer.flushMetrics() / flushLogs()    쌓인 값을 반환하며 동시에 버퍼 비움("읽으면서 비우기")
      │
      ▼
connectionManager.getClients() 순회
      │
      ▼
readyState === OPEN인 소켓에만 send(JSON.stringify(WSMessage))
```

두 tick 사이 새 데이터가 없으면 그 tick엔 아무것도 보내지 않는다("무전송"도 정상 동작). `server.ts`에서 `@fastify/websocket` 플러그인은 반드시 `await app.register(...)`로 등록이 완료된 뒤에 `/ws` 라우트를 등록해야 한다 — 등록 순서가 어긋나면 `{websocket:true}` 라우트가 평범한 HTTP 라우트로 처리되어 핸들러가 `WebSocket` 대신 `Request` 객체를 받는 문제가 있었다(자세한 원인은 아래 트러블슈팅 링크).

---

## 테스트

```bash
npm test --workspace=apps/server        # vitest run — 전 계층(connectionManager/dataBuffer/broadcaster/routes/demo) 1회 실행
npm run test:watch --workspace=apps/server
```

---

## 배포

Render Blueprint로 배포한다 — Render 대시보드에서 "New > Blueprint"로 이 저장소를 연결하면 루트의 [`render.yaml`](../../render.yaml)을 자동으로 읽어 서비스를 구성한다.

| 설정 | 값 |
|---|---|
| Build Command | `npm install && npm run build:server` |
| Start Command | `npm run start --workspace=apps/server` |
| Health Check Path | `/health` |
| 환경 변수 | `DATABASE_URL`, `DIRECT_URL`, `ALLOWED_ORIGIN`은 `sync: false`로 Render 대시보드에서 직접 입력. `DATA_RETENTION_HOURS`는 `render.yaml`에 `"24"`로 고정 |

`DEMO_MODE`는 `render.yaml`에 없으므로 배포 환경에서 데모 데이터 생성을 켜려면 Render 대시보드에서 별도로 `DEMO_MODE=true`를 추가해야 한다.

---

## 세션 작업 로그 / 상세 트러블슈팅

설계 배경과 트러블슈팅 전체 기록은 [docs/](./docs/)에 세션 단위로 남아 있다.

| 세션 | 내용 |
|---|---|
| [Session 1](./docs/SESSION1_WORK_LOG.md) | Fastify 서버 초기 세팅 — 폴더 구조, `tsconfig.json`의 `NodeNext` 선택 이유 |
| [Session 2](./docs/SESSION2_WORK_LOG.md) | Prisma로 Supabase PostgreSQL 연결 — Transaction/Session 풀러 이원화, `db pull` 트러블슈팅 |
| [Session 3](./docs/SESSION3_WORK_LOG.md) | `packages/shared` 공유 타입 패키지 구축 — npm workspaces `workspace:*` 프로토콜 트러블슈팅 |
| [Session 4](./docs/SESSION4_WORK_LOG.md) | WebSocket 서버 + 전송 주기 제어 구현 — `@fastify/websocket` 등록 순서 트러블슈팅, Before 베이스라인 측정 |

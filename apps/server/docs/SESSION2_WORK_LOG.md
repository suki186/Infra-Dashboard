# Session 2 Work Log — Prisma를 통한 Supabase PostgreSQL 연결

---

## 목차

1. [세션 개요](#overview)
2. [Supabase 연결 구조 — Transaction Pooler vs Session Pooler](#connection)
3. [`prisma db pull`로 기존 스키마 이관](#db-pull)
4. [camelCase ↔ snake_case 매핑 — @map / @@map](#mapping)
5. [트러블슈팅 — 문서상 `recorded_at`, 실제는 `created_at`](#troubleshooting)
6. [Prisma Client 싱글턴 패턴](#singleton)
7. [GET /health/db 검증 및 최종 확인](#verify)
8. [핵심 인사이트](#insight)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

Session 1에서 Fastify 프로세스와 `GET /health`만 갖춘 뼈대를 세웠다. `apps/web`의 시뮬레이터(`scripts/simulator.mjs`)는 이미 Supabase Postgres의 `infrastructure_metrics`, `infrastructure_logs` 테이블에 1초 주기로 데이터를 쌓고 있는 상태였다. 이번 세션의 목표는 `apps/server`가 **같은 Supabase 프로젝트의 같은 테이블**을 Prisma를 통해 조회할 수 있도록 연결하는 것이다. 새 테이블을 만드는 것이 아니라, 이미 존재하는 프로덕션 데이터를 대상으로 Prisma 스키마를 역으로 생성(introspection)하는 작업이다.

### 이번 세션 범위

- `DATABASE_URL` / `DIRECT_URL` 이원화 및 Supabase 커넥션 구조 반영
- `npx prisma db pull`로 `infrastructure_metrics`, `infrastructure_logs` 스키마 이관
- Prisma 컨벤션(camelCase)과 실제 컬럼명(snake_case) 매핑
- Prisma Client 싱글톤 구성
- `GET /health/db` 라우트로 실제 DB 연결 검증

---

<a id="connection"></a>
## 2. Supabase 연결 구조 — Transaction Pooler vs Session Pooler

```prisma
// apps/server/prisma/schema.prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

```bash
# apps/server/.env
# Connect to Postgres via the shared transaction-mode pooler (IPv4-only)
DATABASE_URL=postgresql://...@...pooler.supabase.com:6543/postgres...

# Connect to Postgres via the shared session-mode pooler (used for migrations)
DIRECT_URL=postgresql://...@...pooler.supabase.com:5432/postgres...
```

Supabase는 Postgres 앞단에 Supavisor 풀러를 두고, 같은 호스트에서 두 가지 모드를 제공한다.

| | `DATABASE_URL` (6543) | `DIRECT_URL` (5432) |
|---|---|---|
| 모드 | Transaction 모드 | Session 모드 |
| 특징 | 연결마다 트랜잭션 단위로 커넥션을 재사용 (stateless) | 클라이언트당 세션을 고정 유지 |
| 제약 | Prepared statement, advisory lock 등 세션 상태에 의존하는 기능 미지원 | 세션 상태 의존 기능 모두 지원 |
| 용도 | Fastify가 요청마다 짧게 맺는 런타임 쿼리 | `prisma db pull` / `prisma migrate` 같은 스키마 조작 |

Prisma는 `url`과 `directUrl`을 분리 지정하면 **런타임 쿼리는 `url`, 스키마 introspection·마이그레이션은 `directUrl`**을 쓰도록 동작을 나눠준다. Fastify 서버처럼 요청마다 커넥션을 짧게 맺고 끊는 워크로드는 Transaction 풀러(6543)와 궁합이 맞고, `db pull`처럼 세션 상태를 필요로 하는 스키마 조회 작업은 Session 풀러(5432)가 필요하다는 Supabase·Prisma 공식 가이드를 그대로 따랐다.

---

<a id="db-pull"></a>
## 3. `prisma db pull`로 기존 스키마 이관

`apps/server`가 새 테이블을 정의하는 것이 아니라, 시뮬레이터가 이미 채우고 있는 프로덕션 테이블을 그대로 가져와야 했으므로 수기로 모델을 작성하는 대신 `npx prisma db pull`로 실제 DB 스키마를 역산했다.

```diff
 // apps/server/prisma/schema.prisma
 datasource db {
-  provider = "postgresql"
-  url      = env("DATABASE_URL")
+  provider  = "postgresql"
+  url       = env("DATABASE_URL")
+  directUrl = env("DIRECT_URL")
 }

-// Placeholder model — real schema migration happens in a later step.
-model Placeholder {
-  id        String   @id @default(uuid())
-  createdAt DateTime @default(now())
+model InfrastructureLog {
+  id        BigInt   @id @default(autoincrement())
+  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
+  serverId  String   @map("server_id")
+  level     String
+  message   String
+
+  @@map("infrastructure_logs")
+}
+
+model InfrastructureMetric {
+  id          BigInt   @id @default(autoincrement())
+  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
+  serverId    String?  @default("") @map("server_id")
+  status      String?  @default("")
+  cpuUsage    Float?   @map("cpu_usage")
+  memoryUsage Float?   @map("memory_usage")
+  diskIo      Float?   @map("disk_io")
+
+  @@map("infrastructure_metrics")
 }
```

Session 1에서 넣어둔 `Placeholder` 모델은 이번 세션에서 완전히 대체됐다. `InfrastructureMetric`의 `serverId`/`status`가 nullable + 빈 문자열 기본값(`@default("")`)으로 introspect된 것은, 실제 테이블 컬럼이 `NOT NULL` 제약 없이 애플리케이션 레벨(시뮬레이터)에서만 값을 채워온 이력을 그대로 반영한 결과다 — Prisma가 스키마를 지어낸 것이 아니라 DB의 실제 제약을 있는 그대로 읽어온 것이다.

---

<a id="mapping"></a>
## 4. camelCase ↔ snake_case 매핑 — @map / @@map

Prisma Client는 필드명을 camelCase로 노출하는 것이 컨벤션이지만, `infrastructure_metrics`/`infrastructure_logs` 테이블은 `apps/web` 시뮬레이터가 만든 snake_case 컬럼(`server_id`, `cpu_usage`, `created_at` 등)을 그대로 쓰고 있다. `prisma db pull`은 이 차이를 감지해 자동으로 `@map`(컬럼)과 `@@map`(테이블) 애너테이션을 붙여준다 — 수기로 하나씩 매핑을 작성한 것이 아니라 introspection 결과물이다.

| Prisma 필드 (camelCase) | 실제 DB 컬럼 (snake_case) |
|---|---|
| `createdAt` | `created_at` |
| `serverId` | `server_id` |
| `cpuUsage` | `cpu_usage` |
| `memoryUsage` | `memory_usage` |
| `diskIo` | `disk_io` |
| 모델 `InfrastructureMetric` | 테이블 `infrastructure_metrics` |
| 모델 `InfrastructureLog` | 테이블 `infrastructure_logs` |

이 매핑 덕분에 애플리케이션 코드(`server.ts`, 이후 라우트/WebSocket 계층)는 `prisma.infrastructureMetric.count()`처럼 camelCase만 다루면 되고, DB의 snake_case 컬럼명은 Prisma 스키마 레이어 안에 완전히 캡슐화된다. `packages/shared`(Session 3)의 타입이 camelCase로 설계된 것도 이 매핑을 그대로 따른 것이다.

---

<a id="troubleshooting"></a>
## 5. 트러블슈팅 — 문서상 `recorded_at`, 실제는 `created_at`

스키마를 이관하기 전 참고하던 인프라 설계 자료에는 메트릭 테이블의 타임스탬프 컬럼명이 `recorded_at`으로 기재되어 있었다. 그러나 `npx prisma db pull`로 실제 프로덕션 테이블을 introspect한 결과, `infrastructure_metrics`와 `infrastructure_logs` 두 테이블 모두 실제 컬럼명은 `created_at`이었다.

```prisma
// introspection 결과 — 문서상 recorded_at으로 알고 있었지만
// 실제 컬럼은 created_at 이었음이 db pull로 확인됨
createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
```

`apps/web` 쪽에서도 시뮬레이터 초기 버전에서 동일한 컬럼명(`recorded_at`)을 insert payload에 포함시켰다가 컬럼 불일치 오류를 겪은 이력이 있다(`apps/web/docs/SESSION1_WORK_LOG.md` 참고). 이번에는 사람이 컬럼명을 손으로 옮겨 적을 필요 없이 `db pull`이 실제 DB를 그대로 읽어 스키마에 반영했기 때문에, 같은 착오가 `apps/server` 쪽 코드에 다시 들어올 여지 자체가 없었다.

---

<a id="singleton"></a>
## 6. Prisma Client 싱글턴 패턴

```typescript
// apps/server/src/db/client.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

`ts-node`로 서버를 재시작하거나 향후 핫리로드 도구를 도입했을 때, 모듈이 매번 새로 평가되면서 `new PrismaClient()`가 반복 호출되면 커넥션 풀이 누적되어 Supabase 풀러의 최대 커넥션 수를 금방 소진할 수 있다. `globalThis`에 인스턴스를 캐싱해 프로세스 생명주기 동안 단 하나의 `PrismaClient`만 존재하도록 강제했다. `NODE_ENV !== 'production'` 조건으로 캐싱을 개발 환경에만 적용한 것은, 프로덕션에서는 프로세스 자체가 재시작되지 않는 한 모듈이 재평가될 일이 없어 전역 캐싱이 불필요하기 때문이다.

이 클라이언트는 `server.ts`에서 다음과 같이 사용된다.

```typescript
// apps/server/src/server.ts
import { prisma } from './db/client';

app.get('/health/db', async (request, reply) => {
  try {
    const count = await prisma.infrastructureMetric.count();
    return { status: 'ok', infrastructureMetricsCount: count };
  } catch (err) {
    request.log.error(err);
    reply.code(500);
    return { status: 'error', message: (err as Error).message };
  }
});
```

Session 1에서 만들어둔 `app.log`/`request.log` 구조화 로깅을 그대로 재사용해, DB 조회 실패 시 원인을 로그로 남기고 클라이언트에는 `500`과 함께 에러 메시지를 반환하도록 했다.

---

<a id="verify"></a>
## 7. GET /health/db 검증 및 최종 확인

`GET /health/db`가 실제로 Supabase의 데이터를 읽어오는지 확인하기 위해, 시뮬레이터(`apps/web/scripts/simulator.mjs`)를 재기동해 `infrastructure_metrics` 테이블의 row 수가 실제로 늘어나는 것을 라우트 응답으로 관찰했다.

```
# 시뮬레이터 기동 전
$ curl -s http://localhost:3001/health/db
{"status":"ok","infrastructureMetricsCount":4164}

# 시뮬레이터를 잠시 재실행한 뒤
$ curl -s http://localhost:3001/health/db
{"status":"ok","infrastructureMetricsCount":4200}
```

두 응답 사이의 row 수 증가(4164 → 4200)는 `apps/server`가 캐시된 값이 아니라 매 요청마다 Supabase의 실제 최신 상태를 조회하고 있음을 보여주는 근거다. 단순히 연결이 되었다는 것을 넘어, 다른 프로세스(시뮬레이터)가 쓴 데이터를 Fastify 프로세스가 실시간으로 읽어낼 수 있음을 확인한 것이 이번 검증의 핵심이다.


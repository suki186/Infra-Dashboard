# Session 3 Work Log — 프론트-백엔드 공유 타입 패키지 구축

---

## 목차

1. [세션 개요](#overview)
2. [타입 설계 — ServerMetric / LogLevel / LogEntry / WSMessage](#types)
3. [`@infra-dashboard/shared` 패키지 구성](#package)
4. [트러블슈팅 — npm workspaces에서 `workspace:*`가 EUNSUPPORTEDPROTOCOL로 실패한 문제](#troubleshooting)
5. [양쪽 앱 빌드 검증](#verify)
6. [핵심 인사이트](#insight)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

Session 2까지 `apps/server`는 Prisma로 Supabase Postgres를 직접 조회할 수 있게 됐다. 다음 단계는 이 서버가 WebSocket으로 `apps/web`에 실시간 데이터를 밀어주는 것인데, 그 전에 반드시 짚어야 할 문제가 있었다 — **프론트와 백엔드가 같은 메시지를 서로 다른 타입으로 이해하면, 런타임에야 발견되는 필드 불일치가 발생한다**는 점이다. `apps/server`는 Prisma 매핑을 거쳐 camelCase(`serverId`, `cpuUsage`)를 쓰지만, `apps/web`은 Supabase 테이블 컬럼을 그대로 받는 snake_case(`server_id`, `cpu_usage`) 타입을 써왔다.

이 세션에서는 두 워크스페이스가 공유할 수 있는 `packages/shared`를 신설해, 최소한 WebSocket 메시지 계약만큼은 양쪽이 같은 타입 정의를 참조하도록 만들었다.

### 이번 세션 범위

- `packages/shared` 신설
- `ServerMetric`, `LogLevel`, `LogEntry`, `WSMessage` 타입 설계
- `@infra-dashboard/shared` 패키지를 빌드 없이 `.ts` 소스로 직접 참조하도록 구성
- `apps/server`, `apps/web` 양쪽에 의존성 추가
- `apps/server`에 `GET /health/shared-types` 검증 라우트 추가

---

<a id="types"></a>
## 2. 타입 설계 — ServerMetric / LogLevel / LogEntry / WSMessage

```typescript
// packages/shared/src/types.ts

/** Prisma InfrastructureMetric row, shaped for the wire. */
export type ServerMetric = {
  serverId: string
  status: string
  cpuUsage: number
  memoryUsage: number
  diskIo: number
  createdAt: string
}

/** Log severity, matching apps/web's existing LogLevel. */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** Prisma InfrastructureLog row, shaped for the wire. */
export type LogEntry = {
  serverId: string
  level: LogLevel
  message: string
  createdAt: string
}

export type WSMessage =
  | { type: 'metrics'; payload: ServerMetric }
  | { type: 'log'; payload: LogEntry }
```

필드명은 Prisma 스키마(Session 2에서 확정한 `InfrastructureMetric`/`InfrastructureLog`)의 camelCase를 그대로 따른다. `apps/server`가 이미 이 필드명으로 DB를 조회하고 있으므로, WebSocket으로 내보낼 페이로드를 다시 snake_case로 변환하는 불필요한 단계를 만들지 않기 위함이다.

### `metrics` payload를 배열이 아닌 단일 객체로 설계한 이유

`WSMessage`의 `metrics` variant는 `ServerMetric[]`가 아니라 `ServerMetric` 단일 객체를 담는다.

```typescript
| { type: 'metrics'; payload: ServerMetric }   // 서버 1대분 스냅샷 1건
```

지금의 시뮬레이터는 모든 서버의 메트릭을 같은 1초 틱에 한 번에 쓰지만, `apps/server`가 서버별로 독립된 전송 주기를 갖도록 확장될 예정이다(예: 서버마다 다른 폴링/전송 간격). 이 경우 여러 서버의 메트릭이 동시에 도착한다는 보장이 없어지므로, 애초에 배치 배열이 아니라 "서버 한 대의 스냅샷 한 건"을 메시지의 최소 단위로 설계했다. 여러 서버의 메트릭이 필요한 화면에서는 클라이언트가 `WSMessage`를 여러 번 받아 누적하면 된다 — 서버가 배치를 만들어 보내는 것보다, 각 서버가 독립적으로 자신의 상태만 보내는 편이 향후 전송 주기 분리와 맞아떨어진다.

`packages/shared/src/types.ts` 최상단에는 이 설계 배경과, `apps/web`이 아직 이 타입으로 전환되지 않았다는 사실을 함께 남겨두었다.

```typescript
// Field names follow the Prisma schema (apps/server/prisma/schema.prisma)
// in camelCase. apps/web currently uses its own snake_case types
// (src/types/metrics.ts, src/types/terminal.ts, src/config/infrastructure.ts) —
// those are not replaced yet; the migration happens when the WebSocket client
// is wired up.
```

`apps/web`의 기존 snake_case 타입은 지금 당장 바꾸지 않기로 했다. 현재 `apps/web`은 여전히 Supabase Realtime을 직접 구독하고 있어 이 공유 타입을 쓸 지점이 아직 없고, WebSocket 클라이언트가 실제로 붙는 다음 단계에서 자연스럽게 교체될 것이기 때문이다. 이번 세션의 목표는 "타입을 정의해 계약을 명시하는 것"까지이며, 기존 프론트 코드를 억지로 끼워 맞추는 것은 범위 밖으로 남겨두었다.

---

<a id="package"></a>
## 3. `@infra-dashboard/shared` 패키지 구성

```json
// packages/shared/package.json
{
  "name": "@infra-dashboard/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/types.ts",
  "types": "./src/types.ts",
  "exports": {
    ".": {
      "types": "./src/types.ts",
      "default": "./src/types.ts"
    }
  }
}
```

이 패키지는 빌드 단계를 두지 않는다. `main`/`types`/`exports` 모두 `dist/`가 아닌 `src/types.ts`를 직접 가리킨다. 두 워크스페이스(`apps/web`, `apps/server`)가 모두 자체 번들러/컴파일러(Next.js Turbopack, `tsc`)를 가지고 있어 소비하는 쪽에서 알아서 트랜스파일하므로, 공유 패키지 자체가 별도로 컴파일해 `dist`를 산출할 이유가 없었다. `exports`의 `types`/`default` 조건은 Session 1에서 `apps/server`의 `tsconfig.json`을 `moduleResolution: "NodeNext"`로 맞춰둔 덕분에 별도 설정 없이 그대로 해석됐다.

```json
// apps/server/package.json, apps/web/package.json 공통
"dependencies": {
  "@infra-dashboard/shared": "*"
}
```

```typescript
// apps/server/src/server.ts
import type { ServerMetric } from '@infra-dashboard/shared';

app.get('/health/shared-types', async () => {
  const sample: ServerMetric = {
    serverId: 'kr-seoul-web-01',
    status: 'healthy',
    cpuUsage: 12.3,
    memoryUsage: 45.6,
    diskIo: 1.2,
    createdAt: new Date().toISOString(),
  };
  return sample;
});
```

`GET /health/shared-types`는 실제 운영 라우트가 아니라, `@infra-dashboard/shared`에서 가져온 타입이 컴파일 타임뿐 아니라 런타임 임포트 경로에서도 정상 동작하는지 확인하기 위한 검증용 라우트다.

---

<a id="troubleshooting"></a>
## 4. 트러블슈팅 — npm workspaces에서 `workspace:*`가 EUNSUPPORTEDPROTOCOL로 실패한 문제

### 증상

로컬 워크스페이스 패키지를 의존성으로 연결할 때 pnpm/Yarn 생태계에서 흔히 쓰는 `workspace:*` 프로토콜을 그대로 적용했다.

```json
"dependencies": {
  "@infra-dashboard/shared": "workspace:*"
}
```

`npm install`을 실행하자 다음 에러로 설치가 실패했다.

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

### 원인 분석

`workspace:*`는 pnpm과 Yarn(Berry)이 지원하는 전용 프로토콜로, 설치 시점에 실제 로컬 워크스페이스 패키지의 경로로 치환해준다. 반면 이 모노레포는 (Session 1 이전, `chore/monorepo-migration`에서) **npm workspaces**로 구성되어 있다. npm은 `workspace:` 프로토콜 자체를 이해하지 못하고, 버전 스펙 문자열을 URL 프로토콜로 해석을 시도하다가 지원하지 않는 프로토콜이라며 설치를 거부한다.

### 해결

npm workspaces에서 로컬 워크스페이스 패키지를 참조하는 방법은 별도 프로토콜이 아니라, **일반 semver 범위 지정 문자열이 로컬 워크스페이스와 이름이 일치할 때 npm이 자동으로 심볼릭 링크를 건다**는 동작을 이용하는 것이다. 가장 단순한 형태인 `"*"`(모든 버전 허용)로 바꾸자 정상적으로 `node_modules/@infra-dashboard/shared`가 `packages/shared`로 심볼릭 링크됐다.

```diff
 "dependencies": {
-  "@infra-dashboard/shared": "workspace:*",
+  "@infra-dashboard/shared": "*",
 }
```

```
$ npm install
npm error code EUNSUPPORTEDPROTOCOL       # workspace:* 사용 시
                     ↓ 수정
$ npm install
added 1 package                            # "*" 사용 시 정상 설치
```

npm, pnpm, Yarn 세 패키지 매니저 모두 "모노레포 내 로컬 패키지를 참조한다"는 목적은 같지만 문법이 다르다는 점을 이번에 명확히 확인했다 — pnpm/Yarn은 `workspace:` 프로토콜을 명시적으로 요구하고, npm은 그런 프로토콜 없이 이름과 버전 범위 매칭만으로 워크스페이스 내부 패키지를 우선 연결한다.

---

<a id="verify"></a>
## 5. 양쪽 앱 빌드 검증

```
$ npm run build:server
> infra-dashboard-server@0.1.0 build
> tsc -p tsconfig.json
(성공 — 에러 없음)

$ npm run build:web
> apps-web@0.1.0 build
> next build
(성공 — @infra-dashboard/shared 타입 임포트 정상 해석)
```

```
$ curl -s http://localhost:3001/health/shared-types
{"serverId":"kr-seoul-web-01","status":"healthy","cpuUsage":12.3,"memoryUsage":45.6,"diskIo":1.2,"createdAt":"..."}
```

`apps/server`와 `apps/web` 양쪽 모두 `@infra-dashboard/shared`의 타입을 별도 빌드 단계 없이 소스 그대로 임포트해 컴파일에 성공했다. `apps/web`은 이번 세션에서 실제 타입 전환은 하지 않았으므로(위 2장 참고), 이 빌드 검증은 "의존성 연결과 타입 해석이 깨지지 않았다"는 것까지만 확인하는 범위다.

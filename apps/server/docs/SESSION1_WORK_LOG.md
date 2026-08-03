# Session 1 Work Log — Fastify 서버 초기 세팅

---

## 목차

1. [세션 개요](#overview)
2. [폴더 구조 및 의존성 설계](#structure)
3. [tsconfig.json 설계 — moduleResolution: NodeNext를 택한 이유](#tsconfig)
4. [server.ts — Fastify 기동과 GET /health](#server-ts)
5. [루트 워크스페이스 스크립트 연동](#workspace)
6. [검증 결과](#verify)
7. [핵심 인사이트](#insight)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

`chore/monorepo-migration`(PR #6)로 `apps/web` 단일 저장소가 npm workspaces 기반 모노레포로 전환된 직후, 두 번째 워크스페이스인 `apps/server`를 신설했다. 지금까지 `apps/web`은 Supabase 클라이언트(`@supabase/supabase-js`)를 브라우저에서 직접 호출해 DB 조회와 Realtime 구독을 모두 처리해왔다. 이 구조는 인증 키가 클라이언트 번들에 노출되고, 서버 사이드 비즈니스 로직(집계, WebSocket 브로드캐스트 등)을 둘 위치가 없다는 한계가 있었다.

이번 세션의 목표는 그 한계를 해소할 **독립된 Node.js 백엔드 프로세스의 뼈대**를 세우는 것이다. 아직 DB 연결이나 WebSocket 로직은 없고, Fastify 프로세스가 기동되고 `GET /health`가 응답하는 최소 단위까지만 진행한다.

### 이번 세션 범위

- Fastify / TypeScript / Prisma 관련 패키지 설치
- `apps/server` 폴더 구조 설계
- `tsconfig.json` 설정
- `server.ts` 최초 작성 및 `GET /health` 라우트
- 루트 `package.json`에 `dev:server` / `build:server` 스크립트 추가
- `GET /health` 정상 응답 검증

---

<a id="structure"></a>
## 2. 폴더 구조 및 의존성 설계

### 2-1. 폴더 구조

```
apps/server/
├── prisma/
│   └── schema.prisma      ← Placeholder 모델 (Session 2에서 실 스키마로 교체)
├── src/
│   ├── db/                ← DB 클라이언트 계층 (Session 2 예정)
│   ├── routes/            ← REST 라우트 분리 예정
│   ├── ws/                ← WebSocket 브로드캐스트 계층 예정
│   └── server.ts          ← 진입점
├── package.json
└── tsconfig.json
```

`db` / `routes` / `ws` 세 디렉터리는 이번 세션에는 내용물 없이 `.gitkeep`만 커밋했다. `apps/web`이 Session 3(대시보드 지능화) 시점에 와서야 `types/services/hooks/components`로 관심사를 분리했던 것과 달리, 서버는 처음부터 계층을 나눠 시작했다. Fastify 서버는 결국 (1) DB 접근, (2) HTTP 라우트, (3) WebSocket 브로드캐스트라는 세 축으로 커질 것이 명확했기 때문에, `server.ts` 하나에 다 넣고 나중에 쪼개는 대신 빈 폴더라도 먼저 자리를 잡아 두었다.

### 2-2. 의존성 선정

```json
// apps/server/package.json
{
  "dependencies": {
    "@fastify/websocket": "^11.2.0",
    "@prisma/client": "^6.19.0",
    "fastify": "^5.6.1"
  },
  "devDependencies": {
    "@types/node": "^20",
    "prisma": "^6.19.0",
    "ts-node": "^10.9.2",
    "typescript": "^5"
  }
}
```

`@fastify/websocket`과 `@prisma/client`/`prisma`는 이번 세션에서 실제로 쓰이지 않는다. DB 연결(Session 2)과 WebSocket 브로드캐스트는 이후 세션의 작업이지만, 폴더 구조와 마찬가지로 백엔드가 향해야 할 방향이 이미 정해져 있었기 때문에 의존성만 먼저 설치해 두어 다음 세션에서 별도의 설치 커밋 없이 바로 구현에 들어갈 수 있도록 했다.

`ts-node`는 프로덕션 실행이 아닌 개발 중 즉시 실행(`npm run dev`)용으로만 사용하고, 빌드는 `tsc`로 별도 처리한다(`build` / `start` 스크립트 분리, 아래 4장 참고).

---

<a id="tsconfig"></a>
## 3. tsconfig.json 설계 — moduleResolution: NodeNext를 택한 이유

```json
// apps/server/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": false,
    "sourceMap": true,
    "incremental": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`apps/web`은 Next.js가 번들러(Turbopack/webpack)를 통해 모듈을 해석하므로 `moduleResolution: "bundler"` 계열 설정을 그대로 받아 쓰면 되지만, `apps/server`는 번들러 없이 Node.js 런타임이 `.js`/`.ts` 파일을 그대로 해석한다. 이 경우 TypeScript 진영에서 `"node"`(별칭 `"node10"`)로 불리는 고전(classic) 해석 방식은 공식 문서 스스로 **신규 프로젝트에는 권장하지 않는 레거시 전략**으로 명시하고 있다 — `package.json`의 `exports` 조건부 필드나 `.mjs`/`.cjs` 확장자 기반 해석 같은, 실제 Node.js가 수행하는 해석 알고리즘을 정확히 반영하지 못하기 때문이다.

`apps/server`는 Node.js 프로세스로 직접 실행되는 백엔드이므로, 번들러의 관대한 해석 대신 **Node.js가 실제로 수행하는 해석 규칙과 1:1로 대응하는** `"NodeNext"`를 처음부터 선택했다. `module`과 `moduleResolution`을 항상 짝지어 `NodeNext`로 맞춘 이유도 같은 맥락이다 — 둘 중 하나만 다른 값으로 두면 TypeScript가 CJS/ESM 산출물 해석과 소스 상의 모듈 해석 규칙이 어긋난다고 판단해 컴파일을 거부한다. 이 결정은 이후 Session 3에서 `packages/shared`가 `exports` 조건부 필드(`types`/`default`)를 가진 패키지로 추가됐을 때, 별도의 `tsconfig` 수정 없이 그대로 타입을 해석해낼 수 있었던 근거가 되었다.

그 외 옵션은 다음 기준으로 정했다.

| 옵션 | 값 | 이유 |
|------|-----|------|
| `target` / `lib` | `ES2022` | 배포 대상 Node.js(v18+)가 기본 지원하는 최신 문법 사용 |
| `rootDir` / `outDir` | `src` / `dist` | 소스와 빌드 산출물 완전 분리 |
| `isolatedModules` | `true` | `ts-node` 등 파일 단위 트랜스파일 도구와의 호환성 보장 |
| `incremental` | `true` | `tsconfig.tsbuildinfo` 캐시로 재빌드 속도 확보 |
| `strict` | `true` | Prisma가 생성할 타입과의 엄격한 정합성을 처음부터 강제 |

---

<a id="server-ts"></a>
## 4. server.ts — Fastify 기동과 GET /health

```typescript
// apps/server/src/server.ts
import Fastify from 'fastify';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({ logger: true });

app.get('/health', async () => {
  return { status: 'ok' };
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`Server listening on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
```

- `Fastify({ logger: true })`로 기동 즉시 구조화 로깅(pino 기반 JSON 로그)을 확보했다. `console.log` 대신 이 로거를 쓰면 이후 라우트에서 `request.log`를 통해 요청 단위 로그를 남길 수 있다(Session 2의 `/health/db` 에러 로깅에서 바로 이 패턴을 재사용한다).
- `PORT`/`HOST`를 환경 변수로 뽑아 기본값(`3001`, `0.0.0.0`)을 둔 것은 로컬 개발과 배포 환경의 포트/바인딩 차이를 코드 수정 없이 흡수하기 위함이다.
- `.listen()`이 실패하면 `app.log.error(err)`로 원인을 남기고 `process.exit(1)`로 비정상 종료한다. 포트 충돌 등으로 기동에 실패했는데 프로세스가 계속 살아있으면, 프로세스 매니저나 컨테이너 오케스트레이터가 장애를 감지하지 못하고 죽은 서버를 "정상"으로 오인할 수 있기 때문에 명시적인 실패 종료 코드를 반환하도록 했다.

---

<a id="workspace"></a>
## 5. 루트 워크스페이스 스크립트 연동

```diff
 // package.json (루트)
   "scripts": {
     "dev:web": "npm run dev --workspace=apps/web",
     "build:web": "npm run build --workspace=apps/web",
-    "test:web": "npm run test:e2e --workspace=apps/web"
+    "test:web": "npm run test:e2e --workspace=apps/web",
+    "dev:server": "npm run dev --workspace=apps/server",
+    "build:server": "npm run build --workspace=apps/server"
   }
```

기존 `dev:web`/`build:web` 네이밍 컨벤션을 그대로 따라 `dev:server`/`build:server`를 추가했다. 두 워크스페이스가 같은 패턴의 스크립트 이름을 공유하므로, 이후 CI나 다른 개발자가 커맨드를 유추하기 쉽다.

---

<a id="verify"></a>
## 6. 검증 결과

```
$ npm run dev:server
> infra-dashboard-server@0.1.0 dev
> ts-node src/server.ts

{"level":30,"msg":"Server listening on http://0.0.0.0:3001"}
```

```
$ curl -s http://localhost:3001/health
{"status":"ok"}
```

Fastify 프로세스가 정상 기동되고, `GET /health`가 `200 { "status": "ok" }`를 반환함을 확인했다. 위 응답은 이번 세션 이후에도 계속 실행 중인 서버에서 재확인한 실제 결과다.


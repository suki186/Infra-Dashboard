# pulseops-monorepo

이 저장소는 **apps/web** (Next.js 프론트엔드)과 **apps/server** (Fastify 백엔드)로 구성된 모노레포입니다.

## Apps

| 앱 | 설명 |
|----|------|
| [apps/web](./apps/web/README.md) | Next.js 프론트엔드 — 인프라 실시간 대시보드 |
| [apps/server](./apps/server/) | Fastify 백엔드 — WebSocket 및 API 서버 |

## Packages

| 패키지 | 설명 |
|--------|------|
| [packages/shared](./packages/shared/) | 프론트-백엔드 공유 타입 (WebSocket 메시지 타입 등) |

## 빠른 시작

```bash
# 프론트엔드 개발 서버
npm run dev:web

# 프론트엔드 빌드
npm run build:web

# E2E 테스트
npm run test:web
```

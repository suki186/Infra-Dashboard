# Session 8 Work Log — WebSocket 단일 연결 통합 (3중 브로드캐스트 트러블슈팅)

---

## 목차

1. [세션 개요](#overview)
2. [핵심 트러블슈팅 케이스 스터디 — 단일 연결 전환 후 오히려 트래픽이 증가한 문제](#troubleshooting)
3. [검증 결과](#verify)
4. [핵심 인사이트](#insight)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

[Session 7](./SESSION7_WORK_LOG.md)에서 `apps/web`을 Supabase Realtime에서 `apps/server`의 WebSocket(`/ws`)으로 전환하고, 전환 직후 재측정을 진행했다. 그런데 그 결과는 기대와 어긋났다 — 초당 전송 바이트는 줄었지만, 초당 메시지 수는 오히려 늘어나 있었다. Session 7 문서에는 이 수치가 최종 검증 결과가 아니라 "일단 전환은 됐다"는 확인 정도로만 남아 있었고, 왜 메시지 수가 늘었는지에 대한 원인 분석은 이번 세션으로 넘어왔다.

### 이번 세션 목표

재측정에서 나온 이상 신호(메시지 수 증가)를 그냥 넘기지 않고 원인을 추적한다. 근본 원인을 찾아 구조적으로 해결한 뒤, 다시 한번 수치로 재검증해서 최종 결과를 남긴다.

### 이번 세션 범위

| 파일 | 역할 |
|---|---|
| `src/store/useRealtimeStore.ts` | WebSocket 연결·재연결·메시지 파싱 로직을 흡수 — 이번 세션의 핵심 변경 지점 |
| `src/components/common/RealtimeSocketProvider.tsx` | 신규 — 앱 최상위에서 연결을 1회만 초기화하는 UI 없는 컴포넌트 |
| `app/layout.tsx` | `RealtimeSocketProvider`를 최상위에 마운트 |
| `app/page.tsx` | 자체 연결 제거, 스토어 selector 구독으로 교체 |
| `src/components/dashboard/LogTerminal.tsx` | 자체 연결 제거, 스토어 selector 구독으로 교체 |
| `src/hooks/useChartPaint.ts` | 자체 연결 제거, 스토어 selector 구독으로 교체 |
| `src/hooks/useServerSocket.ts` | 삭제 — 더 이상 어디서도 호출되지 않음 |
| `tests/dashboard.spec.ts` | WebSocket 모킹 관련 주석을 새 구조에 맞게 갱신 |

---

<a id="troubleshooting"></a>
## 2. 핵심 트러블슈팅 케이스 스터디 — 단일 연결 전환 후 오히려 트래픽이 증가한 문제

### 증상

WebSocket 전환(Supabase → 자체 Node.js 서버) 직후 재측정한 결과, 초당 메시지 수가 오히려 늘어났다.

| 지표 | Before (Supabase) | After 1차 (전환 직후) |
| --- | --- | --- |
| 초당 메시지 수 | 8.17건/초 | 16.04건/초 (⬆ 약 2배) |
| 초당 전송 바이트 | 5.22 KB/초 | 2.53 KB/초 (⬇ 약 52%) |

바이트는 줄었지만, 메시지 개수가 늘어난 건 명백히 의도와 어긋난 결과였다. 개별 메시지 크기를 줄이는 최적화는 성공했는데, 그 대가로 메시지 수 자체가 늘어난다면 전체적인 트래픽 개선이라 보기 어려웠다.

### 원인 분석

브라우저 Network 탭에서 WebSocket 연결을 확인한 결과, `ws://localhost:3001/ws`에 **동일한 URL로 3개의 개별 연결**이 열려 있었다.

원인은 `page.tsx`, `LogTerminal.tsx`, `useChartPaint.ts` 세 컴포넌트가 각각 독립적으로 `useServerSocket()`을 호출하고 있었기 때문이다. 이 구조 자체는 Session 7에서 의도적으로 선택한 것이었다 — 당시에는 기존 Supabase Realtime의 "컴포넌트별 독립 채널 구독" 구조를 그대로 유지하는 것이 목표였고, 데이터 소스만 교체하는 데 집중했다.

문제는 `apps/server`의 WebSocket 브로드캐스터가 Supabase Realtime의 채널/구독 개념 없이, 연결된 모든 클라이언트에게 전체 데이터(메트릭+로그)를 그대로 흘려보낸다는 점이었다. 컴포넌트 하나가 실제로 필요한 데이터는 일부(예: `LogTerminal`은 로그만, `useChartPaint`는 메트릭만)인데도, 연결 자체가 3개이므로 서버는 동일한 메시지를 3개 연결 각각에 중복 발송했다. 그 결과 총 메시지 수가 3배로 증폭됐다.

### 해결

`useRealtimeStore`(Zustand)가 WebSocket 연결과 메시지 수신 로직을 흡수하여, **연결을 앱 전체에서 단 하나만 유지**하도록 구조를 변경했다.

```tsx
// Before: 컴포넌트마다 개별 연결
function LogTerminal() {
  const { logs } = useServerSocket() // 컴포넌트 A용 연결
}
function useChartPaint() {
  const { metrics } = useServerSocket() // 컴포넌트 B용 연결
}

// After: 스토어가 연결을 소유, 컴포넌트는 selector로 구독만
function LogTerminal() {
  const logs = useRealtimeStore(state => state.logs)
}
function useChartPaint() {
  const metrics = useRealtimeStore(state => state.metrics)
}
```

연결 시작점은 `RealtimeSocketProvider`라는 UI 없는 컴포넌트로 만들어 앱 최상위(`layout.tsx`)에 한 번만 마운트했다. 재연결 로직(끊김 시 2초 후 재시도)은 `useServerSocket.ts`에 있던 것을 그대로 스토어 내부로 옮겼다. React StrictMode의 이중 렌더링으로 연결이 두 번 생성되지 않도록, `RealtimeSocketProvider` 쪽 `useRef` 가드와 스토어 모듈 스코프의 `socketStarted` 플래그를 함께 둬서 이중으로 방어했다 — 스토어 자체가 모듈 싱글턴이므로 플래그 쪽이 최종 방어선이고, `useRef`는 불필요한 재호출을 줄이는 보조 장치다.

메시지 수신 후의 분기(‘metrics’는 메트릭 상태로, ‘log’는 로그 상태로 업데이트)도 스토어 내부 한 곳으로 모았고, 기존에 컴포넌트별로 흩어져 있던 camelCase(`packages/shared`) → snake_case(`apps/web` 로컬 타입) 변환 로직도 함께 정리했다.

---

<a id="verify"></a>
## 3. 검증 결과

- `npm run build --workspace=apps/web`: 성공.
- `npm run lint`: 에러 0 (기존에 있던 `simulator.mjs`의 무관한 경고 1건 제외).
- `npm run test:e2e`: 7/7 통과. WebSocket 모킹(`page.routeWebSocket`)은 원래도 연결 개수에 무관하게 동작하도록 작성돼 있어 로직 변경 없이 주석만 갱신했다.
- `npm run dev:server` + `npm run dev:web` + `node apps/web/scripts/simulator.mjs`를 동시 실행한 뒤 브라우저 콘솔을 확인한 결과, `📡 WebSocket 서버 연결 성공!` 로그가 3회 → **1회**로 줄어든 것을 1차로 확인했다.
- HAR 파일로 재측정한 최종 결과는 다음과 같다.

| 지표 | Before (Supabase) | After 1차 (3연결 중복) | After 최종 (단일 연결) |
| --- | --- | --- | --- |
| 초당 메시지 수 | 8.17건/초 | 16.04건/초 | **5.60건/초** |
| 초당 전송 바이트 | 5.22 KB/초 | 2.53 KB/초 | **0.88 KB/초** |

Before(Supabase) 대비 최종적으로 메시지 수 약 31.4%, 전송 바이트 약 83.1% 감소를 달성했다.

---

<a id="insight"></a>
## 4. 핵심 인사이트

실시간 시스템에서는 메시지 크기 같은 표면적인 최적화 대상뿐 아니라, 연결 토폴로지(연결 개수와 각 연결의 구독 범위) 자체가 성능에 훨씬 큰 영향을 미칠 수 있다는 것을 수치로 확인한 사례였다. 서버가 채널 단위 구독을 지원하지 않는 구조라면, 클라이언트 쪽에서 연결 자체를 공유하는 것이 최적화의 핵심 지렛대가 된다.

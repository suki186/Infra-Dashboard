# Session 3 Work Log — 대시보드 지능화 & 실시간 로그 스트리밍

> **Branch** `feature/ai-chatbot`

---

## 목차

1. [Step 8 — Pulse Doctor AI 챗봇 및 백엔드 API 개통](#step-8)
2. [Step 9 — 실시간 로그 스트리밍 터미널 및 Zero Re-render 파이프라인](#step-9)
3. [최종 엔지니어링 성과 요약](#summary)
4. [Before vs After 비교 분석](#before-after)
5. [AI 관제탑 진단 시스템 설계 원칙](#ai-rules)

---

<a id="step-8"></a>
## Step 8 — Pulse Doctor AI 챗봇 및 백엔드 API 개통

### 8-1. 보안 경계 설계 — Route Handler as Safe Zone

클라이언트 컴포넌트에서 OpenAI API를 직접 호출하면 브라우저 DevTools Network 탭에 `Authorization: Bearer sk-...` 헤더가 그대로 노출된다. 이를 원천 차단하기 위해 Next.js 16 App Router의 **Route Handler**(`app/api/chat/route.ts`)를 보안 경계(Safe Zone)로 구축했다.

```
Browser (Client)
  │  POST /api/chat  { message, metrics, recentLogs }
  ▼
app/api/chat/route.ts        ← OPENAI_API_KEY 는 이 서버 영역에만 존재
  │  Authorization: Bearer $OPENAI_API_KEY
  ▼
api.openai.com/v1/chat/completions
```

`process.env.OPENAI_API_KEY`는 서버 프로세스 메모리에만 존재하며, 클라이언트 번들에 포함되지 않는다. 키가 설정되지 않았을 경우 즉시 `500` 응답을 반환하여 미설정 상태로 운영되는 상황을 조기 차단한다.

```typescript
// app/api/chat/route.ts
export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다.' }, { status: 500 })
  }
  // ...
}
```

### 8-2. 데이터 오케스트레이션 — 메트릭 스냅샷 + 로그 컨텍스트 조율

단순히 유저의 자연어 질문만 LLM에 전달하면 AI는 현재 인프라 상태를 알 수 없다. 클라이언트가 전송하는 페이로드를 **세 레이어**로 구성해 AI가 즉시 현황을 파악할 수 있도록 설계했다.

```typescript
// 백엔드 내부 buildUserMessage() 가 조립하는 최종 프롬프트 구조
📊 현재 인프라 메트릭 스냅샷:
• [kr-seoul-web-01]  CPU 97.3%  /  MEM 82.1%
• [kr-seoul-db-01]   CPU 64.2%  /  MEM 75.4%
• [kr-jeju-ai-01]    CPU 78.9%  /  MEM 70.3%

📋 최근 시스템 로그 (마지막 10줄):
[2026-06-13 14:22:01] [ERROR] [kr-seoul-web-01] FATAL: Connection pool exhausted (max 100)
[2026-06-13 14:22:01] [ERROR] [kr-seoul-web-01] ALERT: CPU thermal throttling active (97.3%)
[2026-06-13 14:22:00] [WARN]  [kr-seoul-db-01]  Connection pool at 84% capacity
...

❓ 질문: 왜 웹 서버가 이렇게 느려졌나요?
```

이 조립은 클라이언트가 아닌 **백엔드(`buildUserMessage`)에서만** 수행된다. 클라이언트는 원시 데이터(message, metrics, recentLogs)만 전달하고, 프롬프트 포맷 제어 권한은 서버 내부에 캡슐화됐다. LLM 프롬프트 구조 변경이 클라이언트 배포 없이 서버 코드만 수정하면 즉시 반영된다.

---

<a id="step-9"></a>
## Step 9 — 실시간 로그 스트리밍 터미널 및 Zero Re-render 파이프라인

### 9-1. 시뮬레이터 개조 — CPU 임계치 연동 로그 생성기

차트 수치와 로그 텍스트가 서로 다른 데이터 소스에서 오면 AI의 교차 진단이 불가능해진다. 기존 메트릭 전용 시뮬레이터(`scripts/simulator.mjs`)를 확장하여 **동일 틱에서 메트릭과 로그를 동시 생성**하도록 개조했다.

```javascript
// scripts/simulator.mjs — generateLogs()
function generateLogs(server, computedMetrics) {
  const { id: server_id, isOffline } = server
  const cpu = computedMetrics.cpu_usage
  const logs = []

  // INFO: 정상 운영 로그 (65% 확률)
  if (Math.random() < 0.65) {
    logs.push({ server_id, level: 'INFO', message: pick(INFO_POOL)() })
  }

  // WARN: CPU 70% 이상 구간에서 항상 발생
  if (cpu >= 70) {
    logs.push({ server_id, level: 'WARN', message: pick(WARN_POOL)(cpu) })
  }

  // ERROR: CPU 90% 이상 (스트레스) 구간에서 1~2줄 강제 발생
  if (cpu >= 90) {
    logs.push({ server_id, level: 'ERROR', message: pick(ERROR_POOL)(cpu) })
    if (Math.random() < 0.55) {
      logs.push({ server_id, level: 'ERROR', message: pick(ERROR_POOL)(cpu) })
    }
  }
  return logs
}
```

**임계치 매핑 원칙:**

| CPU 구간 | 로그 레벨 | 발생 조건 | 메시지 예시 |
|----------|-----------|-----------|-------------|
| 정상 | `INFO` | 65% 확률 | `Connection pool active (42/100)` |
| ≥ 70% | `WARN` | 무조건 | `High CPU load — threshold breached: 73.2%` |
| ≥ 90% | `ERROR` | 무조건 1~2줄 | `FATAL: Connection pool exhausted (max 100)` |
| OFFLINE | `WARN` | 25% 확률 | `Server is OFFLINE — metrics reporting zero` |

메트릭 INSERT와 로그 INSERT는 동일 틱(`setInterval` 콜백) 내에서 순차 실행되어 타임스탬프가 항상 일치한다. 이로써 "CPU 97% 차트 스파이크"와 "Connection pool exhausted 로그"가 같은 시각에 발생함을 AI가 교차 검증할 수 있다.

> **트러블슈팅 기록**: 최초 구현에서 `const { server_id } = server` 로 구조 분해했으나 서버 객체의 실제 키는 `id` 였다. `server_id`는 항상 `undefined`가 되어 `null value in column "server_id" violates not-null constraint` DB 에러가 발생. `const { id: server_id } = server` 로 alias 처리하여 즉시 해결.

### 9-2. Zero Re-render 파이프라인 설계

초당 3~8줄의 로그가 Supabase Realtime으로 인입되는 상황에서 이를 `useState`로 관리하면 매 INSERT마다 React 조정자(Reconciler)가 실행되고, 이벤트 버블링을 통해 `page.tsx` → `RealtimeChart` 순으로 리렌더링이 전파될 위험이 있다.

**설계 원칙**: 로그 데이터를 React 상태 밖에 두고, 최소한의 신호만 React에 전달한다.

```typescript
// src/components/dashboard/LogTerminal.tsx

// ① 로그 배열 — useRef 로 관리 (React 조정자와 완전히 무관)
const logsRef = useRef<LogEntry[]>([])

// ② 렌더 트리거 — 숫자 카운터만 useState 로 관리
const [tick, setTick] = useState(0)

// ③ Supabase 이벤트 핸들러 — useRef 직접 변이 후 tick만 올림
.on('postgres_changes', ..., ({ new: row }) => {
  const logs = logsRef.current
  logs.push(row as LogEntry)                              // 직접 변이 (Direct Mutation)
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)  // 메모리 보호
  setTick(t => t + 1)                                    // 최소 신호만 React에 전달
})
```

**렌더링 전파 경로 비교:**

```
[Before — useState 사용 시]
Supabase INSERT
  → setLogs([...prev, newLog])          ← 새 배열 생성 (GC 압박)
    → LogTerminal re-render
      → page.tsx re-render              ← 불필요한 상위 전파
        → PulseDoctor re-render
        → RealtimeChart re-render       ← 차트 60fps 파이프라인 중단 위험

[After — useRef 직접 변이]
Supabase INSERT
  → logsRef.current.push(row)           ← 배열 직접 변이 (GC 없음)
  → setTick(t => t + 1)
    → LogTerminal re-render             ← 전파 종료. 부모 트리 리렌더링 0회
```

`RealtimeChart`는 `React.memo()`로 감싸져 있고 props가 없으므로 어떤 경로로도 깨어나지 않는다. 로그 스트리밍은 이 격리 원칙을 완벽히 준수한다.

**메모리 보호 — MAX_LOGS = 100:**

```typescript
if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
```

`push` 후 즉시 초과분을 앞에서 제거한다. `slice`를 쓰지 않고 `splice`로 **in-place 제거**하여 새 배열 생성을 방지했다.

**Auto-scroll — smooth 제거:**

```typescript
useEffect(() => {
  if (scrollRef.current) {
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight  // 즉시 이동
  }
}, [tick])
```

`behavior: 'smooth'`를 사용하면 로그가 급증하는 구간(스트레스 시나리오)에서 이전 스크롤 애니메이션이 완료되기 전에 다음 스크롤이 발생해 화면이 흔들리는 janky 현상이 발생한다. 즉시 이동으로 처리했다.

### 9-3. forwardRef + useImperativeHandle — 로그 낚아채기 인터페이스

챗봇이 질문을 전송하는 시점에 "가장 최신 로그 10줄"을 AI 컨텍스트에 포함시켜야 한다. 그러나 다음 두 접근은 모두 문제가 있다.

- **전역 상태(Zustand 등)**: 로그 업데이트마다 구독 컴포넌트가 전부 리렌더됨
- **props 드릴링(useState)**: `page.tsx`에 로그 상태가 올라가면 1초 메트릭 갱신과 합산되어 리렌더 폭발

**선택한 설계 — RefObject 인터페이스:**

```typescript
// src/types/terminal.ts
export type LogTerminalHandle = {
  getRecentLogs: (n?: number) => string[]
}

// src/components/dashboard/LogTerminal.tsx
export const LogTerminal = forwardRef<LogTerminalHandle, object>(
  function LogTerminal(_, ref) {
    const logsRef = useRef<LogEntry[]>([])

    useImperativeHandle(ref, () => ({
      getRecentLogs: (n = 10) =>
        logsRef.current.slice(-n).map(formatLogLine),
    }))
    // ...
  }
)
```

```typescript
// app/page.tsx — ref 는 stable object, state 가 아님
const logTerminalRef = useRef<LogTerminalHandle>(null)

<LogTerminal ref={logTerminalRef} />
<PulseDoctor metrics={metrics} logTerminalRef={logTerminalRef} />
```

```typescript
// src/components/chatbot/usePulseDoctor.ts — 전송 시점에만 읽기
const recentLogs = logTerminalRef?.current?.getRecentLogs(10) ?? []
const content = await sendChatQuestionApi(text, metrics, recentLogs)
```

`useRef`로 생성한 `logTerminalRef`는 렌더링 사이클에 참여하지 않는 **stable object**다. `page.tsx`가 `metrics` 갱신으로 리렌더되더라도 이 ref를 통해 `PulseDoctor`로 전달되는 값은 동일한 참조이므로 추가 리렌더를 유발하지 않는다. `getRecentLogs()`는 전송 버튼을 누르는 순간에만 단 한 번 호출되며, `logsRef.current.slice(-10)` 읽기 연산만 발생한다.

**데이터 흐름 요약:**

```
[로그 쓰기 경로]  — React 외부
  Supabase INSERT → logsRef.current.push() → setTick (UI 갱신)

[로그 읽기 경로]  — React 외부
  사용자 전송 버튼 → logTerminalRef.current.getRecentLogs(10) → fetch('/api/chat')
```

두 경로 모두 React 상태를 경유하지 않는다. 로그 데이터의 생산과 소비가 완전히 React 외부에서 이루어지는 구조다.

---

<a id="summary"></a>
## 최종 엔지니어링 성과 요약

### 구현된 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                   Browser (Client)                       │
│                                                         │
│  page.tsx ──setState(metrics)──► PulseDoctor            │
│     │                               │                   │
│     │  useRef (stable)              │  usePulseDoctor   │
│     └──────── logTerminalRef ───────┘       │           │
│                    │                    aiApi.ts        │
│                    │                        │           │
│             LogTerminal                     │           │
│          useRef(logsRef) ◄── Supabase       │           │
│          useState(tick)      Realtime       │           │
│                                             │           │
│  RealtimeChart (memo, no props)             │           │
│  ─ 절대 리렌더되지 않음 ─                     │           │
└─────────────────────────────────────────────┼───────────┘
                                              │ POST /api/chat
                                    ┌─────────▼───────────┐
                                    │  app/api/chat/route  │
                                    │  OPENAI_API_KEY 격리 │
                                    └─────────┬───────────┘
                                              │
                                    ┌─────────▼───────────┐
                                    │  OpenAI gpt-4o-mini  │
                                    │  메트릭 + 로그 진단  │
                                    └─────────────────────┘
```

### 클린 아키텍처 레이어 분리

```
src/
├── types/           ← 순수 타입 정의 (런타임 코드 없음)
│   ├── chat.ts      — Message, UsePulseDoctorReturn
│   ├── terminal.ts  — LogTerminalHandle, LogLevel, LogEntry
│   └── metrics.ts   — TimeSlot, MetricsBuffer
├── config/          ← 도메인 상수 & 공유 타입
├── services/        ← 네트워크 I/O (React 의존 없음)
│   └── aiApi.ts
├── hooks/           ← 재사용 가능한 상태 로직
│   └── useMetricsBuffer.ts
├── components/      ← UI 컴포넌트 (상태는 hooks에서)
│   ├── chatbot/
│   └── dashboard/
└── utils/           ← 순수 유틸리티 함수
```

---

<a id="before-after"></a>
## Before vs After 비교 분석

| 관점 | Before | After |
|------|--------|-------|
| **보안** | 클라이언트에서 OpenAI 직접 호출 → API 키 브라우저 노출 위험 | Next.js Route Handler가 Safe Zone 역할 → 키가 서버 메모리에만 존재 |
| **코드 구조** | `usePulseDoctor` 내부에 `fetch` 로직 하드코딩 | `aiApi.ts` 서비스 레이어로 분리 → 훅은 비즈니스 로직만 담당 |
| **타입 관리** | 타입 정의가 각 컴포넌트/훅 파일에 산재 | `src/types/` 단일 진실 공급원으로 집중 |
| **AI 답변 품질** | 메트릭 수치 기반 단순 경고 ("CPU가 높습니다") | 실시간 로그 파싱 → 구체적 장애 원인 진단 ("kr-seoul-web-01에서 Connection pool exhausted") |
| **로그 렌더링** | `useState` 기반 → 로그 업데이트마다 부모 트리 리렌더 전파 | `useRef` 직접 변이 → 부모 트리 리렌더링 **0회** |
| **차트 격리** | 로그 상태 변화 시 `RealtimeChart` 리렌더 위험 | `memo()` + props 없음 + 로그 격리로 차트 **절대 리렌더 없음** |
| **메모리 관리** | 로그 무제한 누적 → 장시간 운영 시 메모리 누수 | MAX_LOGS=100 in-place `splice` → 메모리 상한 보장 |
| **스크롤 UX** | `behavior: smooth` → 급증 구간 janky 현상 | 즉시 이동(`scrollTop = scrollHeight`) → 스트레스 구간에서도 안정 |
| **로그 AI 전달** | 전역 상태 공유 필요 → 리렌더 비용 발생 | `forwardRef` + `useImperativeHandle` → stable ref로 0 리렌더 읽기 |
| **시스템 프롬프트** | 없음 (Mock 응답) | 두괄식 강제 + `<details>` 출력 제어 + 4단계 로그 진단 규칙 주입 |

---

*Generated: 2026-06-13 · infra-dashboard `feature/ai-chatbot`*

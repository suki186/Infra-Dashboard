# Infra Dashboard

> **실시간 인프라 관제 + AI 자동 진단** — 60fps 차트 렌더링을 유지하면서 Supabase Realtime으로 로그·메트릭을 스트리밍하고, GPT-4o-mini가 메트릭 + 로그를 교차 분석하여 장애를 즉시 진단합니다.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript 5 · Chart.js 4 · Supabase (Postgres Realtime) · OpenAI GPT-4o-mini · Tailwind CSS v4

---

## 핵심 기능

- **60fps 실시간 차트** — `useRef` 공유 버퍼 + 제로 할당(zero-allocation) 배열 재사용으로 GC 압박 없이 300ms 독립 드로우 루프 구동
- **로그 터미널 스트리밍** — `forwardRef` + `useImperativeHandle` 격리로 초당 수십 건의 INSERT 이벤트가 와도 상위 트리 re-render **0회**
- **AI 교차 진단** — 질문 시점 메트릭 스냅샷 + 최근 로그 10줄을 GPT-4o-mini에 함께 주입, 서버 ID·타임스탬프를 인용한 근거 기반 장애 진단

---

## 기획 의도 & Why Supabase

이 프로젝트의 핵심 과제는 **"초당 여러 서버에서 쏟아지는 이벤트를 받아 차트를 60fps로 유지하면서, 동시에 로그 스트리밍과 AI 진단을 붙이는 것"** 이었습니다.

리소스를 인프라 운영 로직 자체에 집중하기 위해 **Supabase**를 BaaS로 선택했습니다.

| 요구사항 | Supabase로 충족한 방식 |
|---|---|
| 실시간 이벤트 수신 | `postgres_changes` — Postgres INSERT 이벤트를 WebSocket 없이 구독 |
| 서버 관리 제로 | 별도 WebSocket 서버·브로커 없이 DB 자체가 이벤트 소스 |
| 강타입 보장 | Postgres 스키마 → `LogEntry` / `ServerMetric` 타입으로 직결 |
| 시뮬레이터 연동 | `scripts/simulator.mjs`가 직접 Supabase에 INSERT → 실환경과 동일한 경로 |

덕분에 WebSocket 서버·브로커를 직접 운영하지 않고도 실제 장애 시나리오(CPU 급등 → ERROR 로그 → AI 진단)를 구현할 수 있었습니다.

---

## 핵심 아키텍처 Before vs After

### re-render 격리

| | Before | After |
|---|---|---|
| 상태 저장 | `useState<TimeSlot[]>` | `useRef<TimeSlot[]>` (sharedBufferRef) |
| 이벤트 수신 | 이벤트마다 setState → 전체 트리 re-render | 큐 push → 300ms 플러시 → 차트 imperative update |
| 로그 도착 시 | 부모 트리 포함 전체 re-render | `LogTerminal` 서브트리만 tick++ |
| GC 압박 | 매 프레임 새 배열 생성 | `array.length = N` 재사용, 제로 할당 |

### 서비스 레이어 분리

```
Before: usePulseDoctor.ts 에 fetch 인라인
After:  src/services/aiApi.ts → sendChatQuestionApi()
        app/api/chat/route.ts → OPENAI_API_KEY 서버 사이드 격리
```

### AI 컨텍스트 교차 주입

```
Before: 메트릭 스냅샷만 전달
After:  메트릭 스냅샷 + getRecentLogs(10) 로그 10줄 동시 주입
        (ref 읽기 — 전송 시점에 re-render 비용 없음)
```

---

## 임팩트 트러블슈팅

<details>
<summary>① React 19 auto-batching — 다중 서버 메트릭 데이터 유실</summary>

**현상**
3대 서버가 거의 동시에 메트릭 이벤트를 보내면 React 19의 자동 배칭이 `setState` 호출을 묶어 마지막 1개만 반영 → 나머지 서버 데이터 유실, 차트에 서버 1~2대 라인이 간헐적으로 사라짐.

**원인**
```ts
// ❌ Before — 이벤트마다 setState, 배칭으로 앞 이벤트 덮임
const [slots, setSlots] = useState<TimeSlot[]>([])
supabase.on('INSERT', ({ new: row }) => {
  setSlots(prev => [...prev, row])  // 3회 호출 → 1회만 반영
})
```

**해결**
```ts
// ✅ After — useRef 큐에 전부 누적, 300ms 플러시 타이머가 한 번에 처리
const queueRef        = useRef<ServerMetric[]>([])
const sharedBufferRef = useRef<TimeSlot[]>([])

// 이벤트 핸들러: React 렌더러와 완전히 무관
const addDataToBuffer = useCallback((data: ServerMetric) => {
  queueRef.current.push(data)
}, [])

// 300ms 독립 타이머: 큐 전체를 한 번에 병합 후 chart.update('none')
setInterval(() => {
  const pending = queueRef.current.splice(0)
  // ... 타임슬롯 병합 후 sharedBufferRef 직접 변경
}, 300)
```

세 서버의 이벤트가 동시에 와도 큐에 모두 쌓이고, 300ms 타이머가 일괄 처리하여 데이터 유실 0건.

</details>

<details>
<summary>② 15,228ms Long Task — Chart.js 재생성으로 브라우저 멈춤</summary>

**현상**
시뮬레이터 기동 후 약 15초 간격으로 브라우저가 완전히 멈춤. Chrome DevTools Performance 탭에서 **15,228ms짜리 Long Task** 적발.

**원인**
```ts
// ❌ Before — 매 데이터 수신마다 useState 갱신
const [chartData, setChartData] = useState(...)

useEffect(() => {
  setChartData(newData)  // → re-render → canvas unmount → Chart 인스턴스 파괴 → new ChartJS() 재생성
}, [data])
```
Chart.js는 캔버스 생성 시 WebGL 컨텍스트와 수천 개의 DOM 측정을 수행 — 반복 생성이 메인 스레드를 장기 점유.

**해결**
```ts
// ✅ After — Chart 인스턴스를 ref로 1회 생성, imperative API로 데이터만 교체
const chartRef = useRef<ChartJS | null>(null)

// 마운트 시 1회만 생성
useEffect(() => {
  chartRef.current = new ChartJS(canvas, config)
  return () => chartRef.current?.destroy()
}, [])

// 300ms 드로우 루프: 새 배열 생성 없이 기존 배열 재사용 (zero-allocation)
const labels = chart.data.labels as string[]
labels.length = N          // GC 압박 없이 배열 초기화
labels.push(...newLabels)  // 재사용
chart.update('none')       // 애니메이션 스킵, 즉시 렌더
```

Long Task **15,228ms → 0ms**, 차트 업데이트 평균 **< 1ms**.

</details>

---

## 디렉토리 구조

```
infra-dashboard/
├── app/
│   ├── api/chat/route.ts          # Route Handler — OPENAI_API_KEY 서버 사이드 격리
│   ├── page.tsx                   # 메인 대시보드 (Client Component)
│   ├── layout.tsx
│   └── globals.css                # .pd-msg 스코프 CSS (챗봇 <details> 스타일링)
├── src/
│   ├── components/
│   │   ├── chatbot/
│   │   │   ├── PulseDoctor.tsx    # AI 챗봇 — 순수 UI
│   │   │   └── usePulseDoctor.ts  # 챗봇 비즈니스 로직 훅
│   │   └── dashboard/
│   │       ├── RealtimeChart.tsx  # 60fps 차트 (Chart.js imperative)
│   │       ├── RealtimeChart.config.ts
│   │       └── LogTerminal.tsx    # 실시간 로그 터미널 (forwardRef 격리)
│   ├── hooks/
│   │   └── useMetricsBuffer.ts    # useRef 큐 + 300ms 플러시 버퍼
│   ├── services/
│   │   └── aiApi.ts               # AI API I/O 분리 (sendChatQuestionApi)
│   ├── types/
│   │   ├── chat.ts                # Message, UsePulseDoctorReturn
│   │   ├── metrics.ts             # TimeSlot, MetricsBuffer
│   │   └── terminal.ts            # LogTerminalHandle, LogEntry, LogLevel
│   ├── config/
│   │   └── infrastructure.ts      # 서버 목록, ServerMetric, MetricsMap
│   └── utils/
│       ├── supabase.ts            # Supabase 클라이언트 싱글턴
│       └── infrastructureHelpers.ts
└── scripts/
    └── simulator.mjs              # 메트릭 + 로그 동시 시뮬레이션
```

---

## 로컬 구동

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정
cp .env.local.example .env.local
# NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, OPENAI_API_KEY 입력

# 3. 시뮬레이터 기동 (별도 터미널)
npm run simulate

# 4. 개발 서버 기동
npm run dev
```

`npm run simulate`를 먼저 실행하면 Supabase에 3대 서버의 메트릭과 로그가 실시간으로 INSERT되고, 브라우저에서 차트·터미널·AI 진단이 즉시 활성화됩니다.

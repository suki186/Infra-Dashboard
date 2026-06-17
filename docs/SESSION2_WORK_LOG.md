# SESSION 2 — PulseOps 작업 일지
**Branch:** `feature/layout`  
**Scope:** Step 5 (부하 테스트 및 위기 진단) → Step 6 (하이브리드 아키텍처 개조) → Step 7 (관제탑 UI 완성)
**작업자:** suki186  

---

## 목차

1. [Step 5 — 극한 부하 테스트와 프리징 위기 직면](#step-5)
2. [Step 6 — 하이브리드 아키텍처 개조 및 성능 한계 돌파](#step-6)
3. [Step 7 — 시각적 트리거 연동 및 관제탑 레이아웃 완성](#step-7)
4. [최종 엔지니어링 성과 요약](#summary)

---

<a name="step-5"></a>
## Step 5 — 극한 부하 테스트와 프리징 위기 직면

### 5-1. 스트레스 테스트 설계

Session 1 에서 완성한 차트 엔진의 실전 내구성을 검증하기 위해, 시뮬레이터의 메인 루프를 **초당 33회(30ms 단위)** 로 단축하는 가혹 조건을 설계했다. 다중 서버(Seoul Web / Seoul DB / Jeju AI) 3대가 동시에 쏟아내므로 실질적인 이벤트 밀도는 **초당 최대 99건** 에 달했다.

```js
// scripts/simulator.mjs — 스트레스 테스트 단계
const INTERVAL_MS = 30  // 1000ms → 30ms, 33.3× 가속
```

또한 현실적인 장애 시나리오를 연출하기 위해 타임라인도 33.3× 압축했다.

| 이벤트 | 원래 타이밍 | 스트레스 테스트 타이밍 |
|---|---|---|
| Seoul Web STRESS 주입 | T+20s | T+600ms |
| Jeju AI OFFLINE 전환 | T+40s | T+1,200ms |
| 전체 RECOVERY | T+60s | T+1,800ms |

---

### 5-2. 크롬 Performance 패널 계측 — Long Task 15,228ms

30초 구간 녹화 결과, **X축 슬롯이 30개 한계에 도달하는 순간부터** 브라우저 메인 스레드가 완전히 정지하는 Long Task가 반복 관측됐다.

```
┌─────────────────────────────────────────────────────────────┐
│  Timeline  0s ──────────── 10s ─────────── 20s ──── 30s    │
│  Main      ██░░░░░░░░░░░░░░████████████████████░░░░░██████  │
│            ↑정상  ↑30슬롯 도달 ↑ Long Task 15,228ms ↑GC    │
│                                                              │
│  Frames    60fps ─────────── 0fps (정지) ──────── 60fps     │
└─────────────────────────────────────────────────────────────┘
```

**원인 1 — 배열 전체 교체에 의한 GC 누적**  
이전 구현에서 `chart.update()` 직전에 `chart.data.labels = slots.map(s => s.time)` 형태로 매 300ms마다 **새 배열 객체를 생성**했다. 3개 데이터셋 × 30슬롯 × 초당 3.3회 = 초당 약 300개 배열 객체가 Heap에 쌓였고, 슬롯이 가득 차는 시점에 Major GC가 한꺼번에 폭발하면서 수십 초간 프레임이 멈췄다.

**원인 2 — 타임스탬프 역전에 의한 Chart.js 픽셀 연산 무한 루프**  
다중 서버의 이벤트가 네트워크 지연으로 **역순**으로 도착할 때, Chart.js는 X축 레이블이 오름차순이라고 가정하고 픽셀 좌표를 계산한다. 레이블 배열이 `["10:00:02", "10:00:01"]` 처럼 역전되면 내부 이진 탐색이 무한 루프에 빠져 렌더 스레드를 잠식한다.

> **핵심 진단:** 차트 엔진의 문제가 아니었다. 브라우저의 Heap 할당·GC 정책과 Chart.js의 내부 정렬 가정이라는 두 개의 숨겨진 제약이 동시에 폭발한 복합 원인이었다.

---

<a name="step-6"></a>
## Step 6 — 하이브리드 아키텍처 개조 및 성능 한계 돌파

### 6-1. React 상태 레이어 완전 제거 — 리렌더링 0% 격리

기존 구조는 `useMetricsBuffer` 훅 내부의 `useState<TimeSlot[]>` 가 300ms마다 새 배열을 생성해 React Reconciler를 깨웠다. 초당 33회 이벤트 × React Reconciler 호출 = 이벤트 루프 자체가 밀리는 악순환이었다.

**Before (상태 기반 구조):**
```
Supabase 이벤트 → addDataToBuffer() → setTimeSlots() → React Re-render
                                                          → useLayoutEffect
                                                            → chart.update()
```

**After (Ref 공유 메모리 구조):**
```
Supabase 이벤트 → addDataToBuffer() → queueRef.current.push()
                                                ↓ (300ms, 독립 타이머)
                               sharedBufferRef.current 직접 뮤테이션
                                                ↓ (300ms, 독립 타이머)
                               chart 배열 직접 동기화 → chart.update('none')
```

두 타이머는 React 렌더링 사이클과 **완전히 분리**된 독립적인 `setInterval` 이다. React는 마운트 시 단 1회만 렌더링하고, 이후 모든 화면 갱신은 순수 명령형 DOM 뮤테이션으로만 처리된다.

```ts
// src/hooks/useMetricsBuffer.ts
// useState 완전 제거 — React 스케줄러에 아무것도 알리지 않는다
const queueRef        = useRef<ServerMetric[]>([])
const sharedBufferRef = useRef<TimeSlot[]>([])

useEffect(() => {
  const timer = setInterval(() => {
    const pending = queueRef.current.splice(0)  // 원자적 취득
    if (pending.length === 0) return
    // ... sharedBufferRef.current 직접 뮤테이션
  }, 300)
  return () => clearInterval(timer)
}, [])
```

---

### 6-2. Zero-Allocation 배열 뮤테이션 — `length` 트릭

기존 증분 push/shift 방식을 폐기하고, 매 300ms 틱마다 Chart.js 내부 배열을 `sharedBufferRef`와 **완전 동기화**하되 새로운 배열 객체를 단 하나도 생성하지 않는 방식을 채택했다.

```ts
// src/components/dashboard/RealtimeChart.tsx — 독립 렌더 타이머
const labels   = chart.data.labels as string[]
const datasets = chart.data.datasets
const len      = slots.length

// ① length 속성 직접 조정: 배열 객체를 재사용하며 크기만 변경
//    새 배열 생성 없음 → GC 대상 객체 발생량 = 0
labels.length = len
datasets.forEach(ds => { (ds.data as (number | null)[]).length = len })

// ② 인덱스 뮤테이션: 기존 슬롯을 덮어씀
for (let i = 0; i < len; i++) {
  labels[i] = slots[i].time
  SERVER_IDS.forEach((id, j) => {
    (datasets[j].data as (number | null)[])[i] = slots[i].values[id] ?? null
  })
}

chart.update('none')  // 단일 페인트 호출
```

`Array.prototype.length = N`은 V8 엔진 내부에서 배열의 내부 슬롯 수만 조정하며, 기존 메모리 블록을 그대로 유지한다. 매 300ms마다 동일한 메모리 블록을 재사용하므로 GC가 추적해야 할 신규 객체가 발생하지 않는다.

---

### 6-3. 타임스탬프 정렬 보장 — X축 역전 원천 봉쇄

`useMetricsBuffer`의 플러시 루프에서, **신규 슬롯이 삽입되는 분기에서만** 오름차순 정렬을 수행한다. 기존 슬롯 갱신(같은 `HH:MM:SS` 레이블 업데이트)은 배열 순서가 변하지 않으므로 정렬을 건너뜀으로써 불필요한 O(N log N) 연산을 차단했다.

```ts
if (idx >= 0) {
  // 기존 슬롯 제자리 교체 — 정렬 불필요
  buf[idx] = { time: timeLabel, values: newValues }
} else {
  buf.push({ time: timeLabel, values: newValues })
  // HH:MM:SS 고정 포맷 → 사전식 비교 = 시간순 비교
  buf.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  if (buf.length > MAX_SLOTS) buf.splice(0, buf.length - MAX_SLOTS)
}
```

---

### 6-4. 네트워크 병목 우회 — 시뮬레이터 Bulk Insert 도입

무료 티어 Supabase Realtime 서버가 초당 33회 변경 이벤트를 중계하지 못하고 웹소켓 파이프라인에서 버퍼링 병목을 일으키는 현상이 발견됐다. 클라이언트 코드는 극한까지 최적화됐으나, 외부 네트워크 레이어가 병목임을 확인했다.

**해결: 30ms 수집 + 300ms 벌크 발송 2-타이머 아키텍처**

```js
// scripts/simulator.mjs — Bulk Insert 단계
let localBuffer = []

// 30ms 루프: DB 요청 없이 메모리에만 누적
setInterval(() => {
  localBuffer.push(...rows)
}, 30)

// 300ms 루프: 10 세트(30 rows)를 단 1회의 insert()로 묶어 발송
setInterval(async () => {
  const pendingRows = localBuffer.splice(0)  // 원자적 취득
  await supabase.from('infrastructure_metrics').insert(pendingRows)
}, 300)
```

| 지표 | 이전 (개별 insert) | 이후 (Bulk insert) |
|---|---|---|
| Supabase 요청 횟수/초 | ~33회 | ~3회 |
| 커넥션 풀 부하 | 기준 100% | **10%** |
| 1회 전송 rows | 3개 | 최대 30개 |

---

### 6-5. On-Device 가상 Mock 루프 — 외부 의존성 0%로 계측

Supabase 웹소켓마저 제거하고 **브라우저 내부**에서 30ms 폭탄을 직접 생성해 차트 엔진만 단독으로 계측했다. 외부 네트워크 지연이 0인 순수 조건에서 렌더 엔진의 한계를 정밀 측정하기 위함이었다.

```ts
// src/components/dashboard/RealtimeChart.tsx
const MOCK_MODE        = true   // 검증 시; false로 복원하면 Supabase 구독 즉시 복원
const MOCK_INTERVAL_MS = 30

useEffect(() => {
  if (MOCK_MODE) {
    const timer = setInterval(() => {
      const nowMs = Date.now()
      for (const { id, cpu_base, phase } of MOCK_SERVERS) {
        addDataToBuffer(generateMockMetric(id, cpu_base, phase, nowMs))
      }
    }, MOCK_INTERVAL_MS)
    return () => clearInterval(timer)
  }
  // ... Supabase 구독 경로
}, [addDataToBuffer])
```

단일 플래그(`MOCK_MODE`)로 Mock ↔ Supabase 경로를 전환할 수 있어, 다음 세션의 빠른 복원이 보장됐다.

**최종 계측 결과 (Chrome Performance Panel, 30초 구간)**

```
Long Task:  0ms   ← 이전 15,228ms 대비 완전 소멸
Frame Rate: 상시 60fps  (초당 33회 데이터 유입 조건에서)
Heap Usage: 안정적 유지, Major GC 트리거 없음
```

---

<a name="step-7"></a>
## Step 7 — 시각적 트리거 연동 및 관제탑 레이아웃 완성

### 7-1. CPU 90% 임계점 실시간 색상 트리거

300ms 렌더 타이머 루프의 데이터 동기화가 끝난 직후, `slots[len - 1]`(최신 슬롯)만 검사한다. 이미 데이터를 기록한 배열을 다시 읽으므로 추가 연산 비용이 없으며, 색상 변경과 `chart.update('none')`가 **단일 페인트 사이클**에 원자적으로 묶인다.

```ts
// 데이터 동기화 루프 직후
const latest = slots[len - 1]
SERVER_IDS.forEach((id, j) => {
  const cpu = latest.values[id] ?? 0
  const ds  = datasets[j]

  if (cpu >= 90) {
    // 위험 — 강렬한 빨간색으로 전환
    ds.borderColor     = 'rgb(239, 68, 68)'
    ds.backgroundColor = 'rgba(239, 68, 68, 0.08)'
  } else {
    // 정상 복원 — infrastructure.ts 고유 색상으로 복원
    const { color } = SERVER_STYLES[id]
    ds.borderColor     = color
    ds.backgroundColor = color.replace('rgb(', 'rgba(').replace(')', ', 0.08)')
  }
})

chart.update('none')  // 데이터 + 색상이 단일 페인트로 반영
```

이 구현의 핵심은 `SERVER_STYLES`가 **단일 진실 공급원(Single Source of Truth)** 이라는 점이다. 색상 복원 시 하드코딩된 값이 아니라 `infrastructure.ts`에 선언된 값을 그대로 참조하므로, 서버 색상 팔레트가 바뀌어도 트리거 로직을 수정할 필요가 없다.

---

### 7-2. Pulse Doctor 스켈레톤 UI — 관제탑 우측 패널 공사

실시간 AI 진단 챗봇 'Pulse Doctor'의 레이아웃 자리를 선점했다. 실제 AI 기능이 구현되기 전까지 `animate-pulse` + `animate-bounce` 조합으로 동작하는 스켈레톤 UI를 구성해, 사용자가 "AI가 분석 중"이라는 맥락을 즉시 인식하도록 설계했다.


**컴포넌트 격리 (`src/components/chatbot/PulseDoctor.tsx`)**

인라인으로 작성된 ~60줄의 마크업을 `PulseDoctor` Server Component로 완전 격리했다. CSS 애니메이션만 사용하므로 `'use client'` 지시어 없이 서버에서 렌더링되며, `page.tsx`에서는 단 한 줄로 삽입된다.

```tsx
// app/page.tsx — Before
<div className="flex flex-col ... lg:flex-3 ...">
  {/* 60줄의 인라인 스켈레톤 마크업 */}
</div>

// app/page.tsx — After
<PulseDoctor />
```

---

### 7-3. 프로덕션 1초 주기 최종 안착

부하 테스트 종료 후 시뮬레이터를 실무 표준 스펙으로 원복했다. 30ms 수집 + 300ms 벌크 발송 이중 루프를 폐기하고 **단일 1000ms 루프**로 통합했으며, 장애 주입 타임라인도 현실적인 스케일로 복원했다.

```js
// scripts/simulator.mjs — 프로덕션 최종 스펙
const INTERVAL_MS = 1000

setTimeout(() => { web01.isStressed = true  }, 20_000)  // T+20s STRESS
setTimeout(() => { jeju01.isOffline = true  }, 40_000)  // T+40s DOWN
setTimeout(() => { /* 전체 복구 */           }, 60_000)  // T+60s RECOVERY

setInterval(async () => {
  const rows = SERVERS.map(s => generateMetrics(s, now))
    .map(({ server_id, status, cpu_usage, memory_usage, disk_io }) => ({
      server_id, status, cpu_usage, memory_usage, disk_io,
    }))
  await supabase.from('infrastructure_metrics').insert(rows)
}, INTERVAL_MS)
```

클라이언트의 `RealtimeChart.tsx`에서는 `MOCK_MODE = false`로 복원하여 Supabase `postgres_changes` 실시간 구독을 즉시 재활성화했다.

---

<a name="summary"></a>
## 최종 엔지니어링 성과 요약

### Before vs After — 정량적 비교

| 측정 지표 | Before (Session 1 완성 시점) | After (Session 2 완성) |
|---|---|---|
| Long Task 최대 지속 시간 | **15,228ms** | **0ms** |
| 브라우저 Frame Rate | 0fps (간헐적 완전 정지) | **상시 60fps** |
| 컴포넌트 리렌더링 횟수/초 | 33회 (useState 호출) | **0회** |
| 300ms 틱당 신규 배열 할당 | 4개 (labels + 3 datasets) | **0개** |
| Major GC 트리거 | 20초 주기 반복 | **없음** |
| Supabase 요청 횟수/초 (부하 테스트 중) | 33회 | 3회 (Bulk, **-91%**) |
| X축 레이블 역전 가능성 | 있음 | **없음** (sort 보장) |

### 파일 아키텍처 최종 구조

```
src/
├── components/
│   ├── dashboard/
│   │   ├── RealtimeChart.tsx         # 데이터 소스 + 렌더 루프 (순수 명령형)
│   │   └── RealtimeChart.config.ts   # Chart.js 설정 분리 (PAINT_MS, CHART_OPTIONS, makeInitialDatasets)
│   └── chatbot/
│       └── PulseDoctor.tsx           # AI 챗봇 스켈레톤 UI (Server Component)
├── hooks/
│   └── useMetricsBuffer.ts           # queueRef + sharedBufferRef, 300ms 플러시 타이머
└── config/
    └── infrastructure.ts             # SERVER_STYLES — 색상·레이블 단일 진실 공급원

scripts/
└── simulator.mjs                     # 1000ms 단일 루프 (프로덕션 스펙)

app/
└── page.tsx                          # 레이아웃 조율만 담당, 비즈니스 로직 없음
```

### 핵심 설계 원칙 — 이 세션에서 관철한 것들

**① React를 데이터 버스로 쓰지 않는다**  
초당 33회 상태 업데이트는 React Reconciler를 데이터 버스로 오용하는 것이다. 고빈도 스트림은 `useRef`가 소유한 공유 메모리로 격리하고, React는 마운트 시 레이아웃만 선언하도록 역할을 분리했다.

**② 메모리 프로파일러가 문제를 먼저 알려준다**  
Long Task의 원인을 "Chart.js 버그"로 오해하기 쉬웠지만, Chrome Memory 탭에서 배열 객체 할당 빈도를 추적하자 매 틱 4개 배열 생성이라는 진짜 원인이 드러났다. 렌더링 성능 문제는 항상 메모리 할당 패턴에서 시작된다.

**③ 단일 진실 공급원(SSOT)이 트리거 로직을 미래-proof하게 만든다**  
CPU 색상 트리거가 `SERVER_STYLES[id].color`를 직접 참조하도록 설계한 덕분에, 향후 서버가 추가되거나 팔레트가 변경되어도 `infrastructure.ts` 한 곳만 수정하면 트리거 복원 로직이 자동으로 동기화된다.

**④ 스켈레톤 UI는 기능이 없는 빈 공간이 아니다**  
`animate-pulse` + `animate-bounce` 조합으로 구현한 Pulse Doctor 스켈레톤은, 실제 AI 기능 없이도 사용자가 "분석 대기 중"이라는 맥락을 즉시 인식하게 만든다. 기능과 UX를 분리해서 개발할 수 있는 구조를 선제적으로 확보한 것이다.

---

*문서 작성: Claude Sonnet 4.6 (PulseOps 개발 세션 기록)*  
*브랜치: `feature/layout` — `main` 병합 준비 완료*

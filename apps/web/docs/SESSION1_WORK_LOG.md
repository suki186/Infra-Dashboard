# SESSION 1 — PulseOps 작업 일지

**프로젝트명:** PulseOps — 실시간 인프라 관제 SaaS 대시보드  
**세션 일자:** 2026-06-10  
**작업자:** suki186  
**스택:** Next.js 16.2.9 / React 19.2.4 / Tailwind CSS v4 / Supabase / Chart.js 4.5.1

---

## 개요

단일 세션에서 인프라 관제 대시보드의 기반 파이프라인 전체를 0에서 구축했다.  
데이터 생성(시뮬레이터) → 저장(Supabase) → 스트리밍(WebSocket) → 시각화(Chart.js)로 이어지는  
엔드 투 엔드 실시간 데이터 흐름을 완성한 뒤, 스트레스 테스트를 통해 고빈도 이벤트 수신 환경에서  
발생하는 **렌더링 병목**을 계측하고 근본 원인을 진단했다.

---

## Step 1 — 프로젝트 초기화 및 가상 메트릭 시뮬레이터 구축

### 1-1. 환경 구성

| 항목 | 결정 및 근거 |
|---|---|
| **Next.js 16** | App Router 기반, Server/Client Component 분리 아키텍처 채택 |
| **Tailwind CSS v4** | `@import "tailwindcss"` 단일 지시어 방식 (v3의 `@tailwind base/components/utilities` 폐기) |
| **TypeScript strict** | `tsconfig.json`에 `"strict": true` 설정, 전 파일 타입 안전성 확보 |
| **App Router 위치** | `src/app/` 가 아닌 루트 `app/` 디렉토리 사용 (Next.js 16 기본값) |

초기화 후 불필요한 보일러플레이트(`globals.css` 내 기본 CSS 변수, `page.tsx` 더미 마크업)를 전량 제거하고, 아래 폴더 구조를 선제적으로 설계했다.

```
infra-dashboard/
├── app/                  # Next.js App Router 엔트리
├── src/
│   ├── components/
│   │   ├── common/       # Sidebar, 공용 UI
│   │   └── dashboard/    # 도메인별 차트, 카드 컴포넌트
│   ├── config/           # 단일 진실 공급원 (서버 ID, 색상 등 상수)
│   ├── hooks/            # 커스텀 훅
│   └── utils/            # Supabase 싱글턴, 헬퍼 함수
└── scripts/              # 서버 사이드 시뮬레이터 (Node.js)
```

### 1-2. 가상 인프라 메트릭 시뮬레이터 (`scripts/simulator.mjs`)

Node.js ESM 모듈(`.mjs`)로 작성했다. CommonJS `require()`는 프로젝트 ESLint 규칙에 의해 금지되어 있어 `.js` 확장자 대신 `.mjs`를 선택, `import` 구문을 사용했다.

**모델링한 가상 서버 3대:**

| 서버 ID | 역할 | CPU 기준치 | 메모리 기준치 | 위상차 |
|---|---|---|---|---|
| `kr-seoul-web-01` | Web 서버 | 45% | 55% | 0° |
| `kr-seoul-db-01` | DB 서버 | 62% | 73% | 60° (π/3) |
| `kr-jeju-ai-01` | AI 서버 | 76% | 68% | 120° (2π/3) |

**삼각함수 기반 메트릭 생성 알고리즘:**

각 메트릭 값은 장주기·단주기 사인·코사인 파동과 랜덤 노이즈의 합성으로 생성되어  
단조로운 난수가 아닌 현실적인 부하 곡선을 시뮬레이션한다.

```
cpu = base
    + 18 · sin(t · 2π/300 + phase)   // 5분 주기 장파
    +  6 · cos(t · 2π/60  + phase)   // 1분 주기 단파
    + rand(5)                          // ±5% 노이즈
```

메모리는 7분 주기(`2π/420`), 디스크 I/O는 2분 주기(`2π/120`)로 각각 독립 파동을 갖는다.  
서버 간 위상차(0°/60°/120°)를 부여해 동시 스파이크를 방지, 합산 부하를 자연스럽게 분산시켰다.

**장애 주입 시나리오 (1000ms 인터벌 기준):**

| 시각 | 이벤트 | 효과 |
|---|---|---|
| T+20s | STRESS 주입 | `kr-seoul-web-01` CPU → 95–99%, 디스크 I/O 폭주 |
| T+40s | OFFLINE 전환 | `kr-jeju-ai-01` 모든 메트릭 0, 상태 `OFFLINE` |
| T+60s | 전체 RECOVERY | 두 서버 삼각함수 파동으로 정상 복귀 |

---

## Step 2 — Supabase 시계열 테이블 설계 및 Realtime 파이프라인 연동

### 2-1. 테이블 스키마

```sql
CREATE TABLE infrastructure_metrics (
  id          bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id   text    NOT NULL,
  status      text    NOT NULL DEFAULT 'ONLINE',
  cpu_usage   numeric NOT NULL,
  memory_usage numeric NOT NULL,
  disk_io     numeric NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

`recorded_at` 컬럼은 존재하지 않으며 `created_at`이 자동 생성된다.  
초기 시뮬레이터 코드가 insert payload에 `recorded_at`을 포함해 **컬럼 불일치 오류**가 발생했고,  
구조 분해 할당으로 필요한 5개 필드만 추출하도록 수정해 해결했다.

```js
// 수정 전: recorded_at 포함 → Supabase 400 에러
// 수정 후: 5개 컬럼만 명시적 추출
const rows = metrics.map(({ server_id, status, cpu_usage, memory_usage, disk_io }) => ({
  server_id, status, cpu_usage, memory_usage, disk_io,
}))
```

Supabase 대시보드에서 해당 테이블에 대해 **Realtime Publication**을 활성화했다.

### 2-2. Supabase 클라이언트 싱글턴 (`src/utils/supabase.ts`)

`createClient`를 모듈 수준에서 단 한 번 인스턴스화해 전역 싱글턴으로 내보냈다.  
환경 변수는 `.env.local`에서 관리하며, `.gitignore`의 `.env*` 패턴에 의해 레포지토리에서 제외된다.

```ts
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)
```

시뮬레이터(Node.js 환경)는 `dotenv.config({ path: '.env.local' })`로 같은 파일을 읽어  
프론트엔드와 동일한 자격증명을 공유한다.

### 2-3. Realtime 구독 아키텍처

`app/page.tsx`(요약 카드용)와 `RealtimeChart.tsx`(차트용)가 **각각 별도 채널**을 구독한다.  
이 설계는 React 18 자동 배칭(Automatic Batching) 버그를 수정하는 과정에서 도출됐다.

**버그 재현 경위:**  
배치 insert(3행 동시 저장) → Supabase가 3개의 `postgres_changes` 이벤트를 동기적으로 발행  
→ React 18이 3번의 `setLatestMetric()` 호출을 단일 렌더 배치로 병합  
→ 마지막 이벤트(AI 서버)만 상태에 반영 → `kr-seoul-db-01` 주황색 라인 **미표시**

**수정 방향:**  
차트 컴포넌트가 props를 통해 데이터를 수신하는 구조를 폐기하고,  
`RealtimeChart`가 자체 채널(`realtime_chart_feed`)을 직접 구독해  
각 이벤트를 독립적으로 처리하도록 재설계했다.

---

## Step 3 — 관제 UI 구축, Chart.js 이식, 상수 단일화

### 3-1. 대시보드 레이아웃

다크 모드 기반 3-구역 레이아웃을 구현했다.

```
┌─────────────────────────────────────────────────────────┐
│  Sidebar (고정 너비)  │  메인 콘텐츠 영역 (flex-1)       │
│  - 로고               │  ┌─ Header: 시스템 상태 바 ─────┐ │
│  - 네비게이션 4개     │  ├─ 요약 카드 × 3 (grid-cols-3)─┤ │
│    Activity / Bot /   │  └─ 차트 70% │ 챗봇 30% ────────┘ │
│    Logs / Settings    │                                   │
└─────────────────────────────────────────────────────────┘
```

Sidebar는 `usePathname()`으로 현재 경로를 감지해 활성 링크를 `bg-blue-600`으로 하이라이트한다.  
요약 카드 3개(서버 수 / 평균 CPU / 시스템 위험도)는 `deriveStats()` 헬퍼로 `MetricsMap`에서 파생된다.

### 3-2. Chart.js 실시간 꺾은선 차트

`chart.js@4.5.1` + `react-chartjs-2@5.3.1` 조합으로 구현했다.

**주요 설정:**

| 옵션 | 값 | 이유 |
|---|---|---|
| `animation: false` | 비활성화 | 고빈도 갱신 시 애니메이션 큐 누적으로 인한 프레임 드롭 방지 |
| `maintainAspectRatio: false` | 비활성화 | 부모 flex 컨테이너의 동적 높이에 맞게 캔버스 리사이즈 |
| `spanGaps: true` | 활성화 | 서버 OFFLINE 구간의 `null` 값을 선으로 연결해 연속성 유지 |
| `maxTicksLimit: 10` | 10개 | X축 레이블 밀도 제어, 가독성 확보 |

슬라이딩 윈도우(최대 30 슬롯)로 오래된 데이터를 `shift()`해 메모리 누수를 방지한다.  
`TimeSlot` 구조(`{ time: HH:MM:SS, values: Record<server_id, cpu_usage> }`)로  
동일 초에 도착한 3개 서버 데이터를 단일 X축 포인트로 묶는다.

### 3-3. 단일 진실 공급원 (`src/config/infrastructure.ts`)

서버 ID 목록과 Chart.js 색상 팔레트가 `RealtimeChart.tsx` 내부에 고립되어 있던 문제를  
별도 모듈로 추출해 해결했다. 이후 `page.tsx`·`RealtimeChart.tsx`·`infrastructureHelpers.ts` 모두  
이 파일에서 타입과 상수를 가져오는 단일 출처 구조가 됐다.

```ts
// src/config/infrastructure.ts
export type ServerMetric = { server_id, status, cpu_usage, memory_usage, disk_io }
export type MetricsMap   = Record<string, ServerMetric>
export const SERVER_STYLES: Record<string, { label: string; color: string }> = { ... }
export const SERVER_IDS = Object.keys(SERVER_STYLES)
```

---

## Step 4 — 스트레스 테스트 및 렌더링 병목 진단

### 4-1. 시뮬레이터 과부하 모드 개조

정상 모드(1000ms 인터벌)에서 과부하 모드(30ms 인터벌)로 전환해 **초당 약 33회 insert**를 수행하도록 변경했다.

**변경 내역:**

| 항목 | 정상 모드 | 스트레스 모드 |
|---|---|---|
| `INTERVAL_MS` | 1000ms | **30ms** |
| 초당 DB insert | ~1회 | **~33회** |
| 장애 주입 타이밍 | T+20s / T+40s / T+60s | **T+600ms / T+1.2s / T+1.8s** |
| 터미널 출력 | 서버 테이블 전체 렌더 | **`\r` 커서 복귀로 한 줄 덮어쓰기** |

터미널 출력 방식을 `console.log()`(전체 테이블 재출력)에서 `process.stdout.write('\r...')`로  
교체해 33회/초 환경에서 터미널 버퍼 과부하를 방지했다.

### 4-2. Chrome Performance 탭 계측 결과

| 지표 | 측정값 | 기준치 |
|---|---|---|
| **최대 프레임 지연** | **89.4 ms** | 16.67ms (60fps) |
| **Long Task 지속 시간** | ~89ms | 50ms 초과 시 jank 발생 |
| **FPS 드롭 구간** | 30ms 인터벌 지속 시 반복 발생 | — |

60fps 기준 프레임 예산은 **16.67ms**다. 측정된 89.4ms Long Task는 이 예산을 **5.4배** 초과하며,  
사용자 입력(클릭, 스크롤)이 해당 구간 동안 차단(Input Blocking)된다.

### 4-3. React Profiler 계측 결과

| 지표 | 측정값 | 비고 |
|---|---|---|
| **단건 렌더링 소요 시간** | 0.7 ms | 렌더 자체는 경량 |
| **관측 구간 내 재렌더링 횟수** | **133회 이상** | 30ms 인터벌 × 구독 컴포넌트 수 누적 |
| **병목 원인** | 렌더 품질이 아닌 **렌더 빈도** | — |

단건 렌더(0.7ms)는 무해하지만, **133회 이상의 재렌더링이 4초 관측 구간에 밀집**되면  
가상 DOM 비교(Reconciliation) 비용이 누적되어 Main Thread를 장시간 점유한다.  
이것이 Chrome Performance에서 포착된 89.4ms Long Task의 근본 원인이다.

### 4-4. 진단 요약

```
WebSocket 이벤트 수신 (33회/초)
  └→ Supabase postgres_changes 콜백 (33회/초)
       └→ setState() 호출 (33회/초)
            └→ React 재렌더링 (33회/초)
                 └→ Reconciliation 누적 → Long Task 89.4ms → 프레임 지연
```

**핵심 진단:** 병목은 렌더링 로직의 무게(0.7ms/건)가 아니라 **렌더링 빈도(33회/초)**에 있다.  
해결 방향은 데이터 수신(ingestion)과 UI 갱신(display)을 디커플링하는 것이다.

---

## 다음 세션 작업 예정 — `useMetricsBuffer` 훅 설계

위 진단을 바탕으로 다음 세션에서 아래 아키텍처를 구현할 예정이다.

```
WebSocket 이벤트 (33회/초)
  └→ addDataToBuffer()          ← useRef 큐 (렌더링 없음)
       └→ setInterval 300ms     ← 배치 플러시
            └→ setMetrics()     ← 렌더링 발생 (최대 3.3회/초)
                 └→ buildTimeSlots() → Chart.js 갱신
```

| 항목 | 현재 | 목표 |
|---|---|---|
| 초당 `setState` 호출 | **33회** | **≤ 3.3회** (300ms 스로틀링) |
| 예상 Long Task 제거 | 89.4ms 발생 | 16.67ms 이내 수렴 |
| 구현 파일 | — | `src/hooks/useMetricsBuffer.ts` |

---

## 파일 변경 이력 (Step 1–4)

| 파일 | 작업 |
|---|---|
| `app/page.tsx` | 보일러플레이트 제거 → Realtime 구독 → 요약 카드 UI |
| `app/layout.tsx` | Sidebar 적용, 전역 레이아웃 |
| `src/components/common/Sidebar.tsx` | 다크 사이드바, `usePathname` 활성 링크 |
| `src/components/dashboard/RealtimeChart.tsx` | Chart.js 이식, 자체 채널 구독 (배칭 버그 수정) |
| `src/config/infrastructure.ts` | 타입 + 상수 단일 진실 공급원 (신규 생성) |
| `src/utils/supabase.ts` | Supabase 싱글턴 클라이언트 |
| `src/utils/infrastructureHelpers.ts` | `deriveStats`, `systemStatusLabel` 분리 |
| `scripts/simulator.mjs` | 삼각함수 시뮬레이터 → 장애 주입 → 30ms 과부하 모드 |
| `.env.local` | Supabase 자격증명 (`.gitignore` 제외) |

# Session 5 Work Log — 차트 시계열 역방향 무한 스크롤 & 실시간 데이터 정밀 병합 아키텍처

> **Branch** `feat/chart-pagination`

---

## 목차

1. [세션 개요](#overview)
2. [구현 내역 (Step 15 — 커서 기반 히스토리 페이징)](#step15)
3. [구현 내역 (Step 16 — Zustand 실시간 피드 병합)](#step16)
4. [핵심 트러블슈팅 케이스 스터디](#troubleshooting)
5. [아키텍처 성과 및 설계 원칙](#architecture)
6. [최종 성과 요약](#summary)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

Session 4에서 완성된 PulseOps 대시보드는 Supabase Realtime을 통해 실시간 메트릭을 스트리밍하지만, 사용자가 30슬롯(약 5분치)을 초과한 과거 시계열을 탐색할 방법이 없었다. 차트가 현재 시점에 고정된 슬라이딩 윈도우로만 동작했기 때문에, 이상 징후가 5분 이전에 발생했다면 운영자는 이를 차트에서 확인할 수 없는 구조적 공백이 존재했다.

### 목표

- **Step 15**: TanStack Query `useInfiniteQuery`와 커서 기반 Mock API를 연동하여, 차트를 왼쪽으로 스크롤했을 때 과거 데이터를 자동으로 페이징하는 역방향 무한 스크롤을 구현한다.
- **Step 16**: Zustand 스토어를 실시간 데이터 피드 레이어로 도입하고, 과거 이력(`allMetrics`)과 실시간 슬롯을 Map 기반 중복 제거 알고리즘으로 오차 없이 병합하여 단일 `combinedData`로 차트에 주입한다.

### 기술 스택

| 레이어 | 기술 |
|--------|------|
| 히스토리 페이징 | TanStack Query v5 `useInfiniteQuery` |
| 실시간 피드 상태 | Zustand v5 (`create`, `.subscribe()`) |
| 데이터 병합 | `Map<timestamp, CombinedSlot>` — O(n) 중복 제거 |
| 차트 렌더링 | Chart.js (ref-based, zero React state) |
| 스크롤 트리거 | `IntersectionObserver` + 동기 락 |

---

<a id="step15"></a>
## 2. 구현 내역 — Step 15: 커서 기반 히스토리 페이징

### 2-1. Mock API Route

**`app/api/metrics/history/route.ts`**

결정론적 시드 기반 난수 생성기를 활용해 동일 타임스탬프에 항상 동일한 값을 반환하는 가상 시계열 API를 구축했다.

- `cursor` 파라미터(ISO 타임스탬프): 있으면 해당 시각 **이전** 데이터, 없으면 현재 기준 최신 데이터
- `limit` (기본값 50, 최대 200): 페이지당 반환 포인트 수
- `nextCursor`: 반환된 배열 중 가장 오래된 타임스탬프 — 다음 페이지 요청 키

```ts
// 핵심 페이징 로직
const anchorMs = cursorParam
  ? Date.parse(cursorParam) - INTERVAL_MS   // cursor 포인트 자체는 이전 페이지 소속
  : Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS  // 현재 기준 최신 슬롯
```

### 2-2. `useMetricsHistory` 훅

**`src/hooks/useMetricsHistory.ts`**

```ts
const query = useInfiniteQuery<
  HistoryPage,
  Error,
  InfiniteData<HistoryPage>,
  string[],
  string | null
>({
  queryKey:         ['metrics-history', String(limit)],
  queryFn:          ({ pageParam }) => fetchHistoryPage(pageParam, limit),
  initialPageParam: null,        // 최초 요청 = cursor 없음 = 최신 50개
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
})
```

모든 페이지를 `flatMap`으로 평탄화한 `allMetrics: HistoryPoint[]`와 함께 `fetchNextPage`, `hasNextPage`, `isFetchingNextPage`를 반환해 소비 컴포넌트의 인터페이스를 단순하게 유지했다.

### 2-3. `QueryProvider` 및 초기화 오류 수정

초기 구현에서 `useRef`를 렌더링 도중 뮤테이션하는 패턴(`if (!clientRef.current) clientRef.current = new QueryClient()`)이 React의 렌더 순수성 규칙을 위반해 `"Cannot access refs during render"` 오류를 유발했다.

**수정**: `useState(() => new QueryClient({ ... }))` 지연 초기화 패턴으로 교체. `useState`의 초기화 함수는 컴포넌트 수명 동안 단 한 번만 실행되어 동일 `QueryClient` 인스턴스가 유지된다.

---

<a id="step16"></a>
## 3. 구현 내역 — Step 16: Zustand 실시간 피드 병합

### 3-1. Zustand 실시간 스토어

**`src/store/useRealtimeStore.ts`**

Supabase INSERT 이벤트를 10초 경계(`SLOT_MS = 10,000`)로 floor한 ISO 타임스탬프 슬롯에 집계한다. 동일 슬롯 내 여러 서버 이벤트를 불변 업데이트(`slice` + spread)로 병합하며, 최대 300슬롯(약 50분치) 초과 시 앞에서 제거한다.

```ts
ingest: (metric) =>
  set((prev) => {
    const ts  = floorToSlotISO(Date.now())  // 10초 단위 ISO 타임스탬프
    const idx = prev.slots.findIndex(s => s.timestamp === ts)

    if (idx >= 0) {
      const slots = prev.slots.slice()
      slots[idx]  = { timestamp: ts, servers: { ...slots[idx].servers, [metric.server_id]: snap } }
      return { slots }
    }
    // 새 슬롯 추가 후 MAX_SLOTS 초과분 제거
    const slots = [...prev.slots, { timestamp: ts, servers: { [metric.server_id]: snap } }]
    return { slots: slots.length > MAX_SLOTS ? slots.slice(-MAX_SLOTS) : slots }
  })
```

### 3-2. `computeCombined` — Map 기반 병합 알고리즘

두 소스의 타임스탬프 형식이 모두 ISO 8601이므로 `Map<string, CombinedSlot>`으로 O(n) 중복 제거가 가능하다.

```ts
function computeCombined(historical: HistoryPoint[], realtime: RealtimeSlot[]): CombinedSlot[] {
  const map = new Map<string, CombinedSlot>()

  // 과거 데이터 먼저 삽입 (실시간이 나중에 덮어쓴다)
  for (const p of historical) map.set(p.timestamp, toMinimal(p))

  // 실시간 데이터 삽입 — 동일 타임스탬프 충돌 시 실시간 우선(override)
  for (const s of realtime)   map.set(s.timestamp, toMinimal(s))

  // oldest → newest 정렬
  return Array.from(map.values()).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  )
}
```

**충돌 정책**: 동일 타임스탬프에서 실시간 데이터가 과거 Mock 데이터를 덮어쓴다. 실시간 데이터가 항상 더 정확한 소스이기 때문이다.

### 3-3. 리렌더링 제로(Zero Re-render) 구독 전략

```ts
// useRealtimeStore(s => s.slots)  ← 이 방식은 사용하지 않는다
// 초당 수십 회 ingest 업데이트 시 동수의 React 리렌더를 유발하기 때문

useEffect(() => {
  realtimeSlotsRef.current = useRealtimeStore.getState().slots
  combinedDataRef.current  = computeCombined(allMetricsRef.current, realtimeSlotsRef.current)

  const unsubscribe = useRealtimeStore.subscribe((state) => {
    realtimeSlotsRef.current = state.slots
    combinedDataRef.current  = computeCombined(allMetricsRef.current, state.slots)
  })
  return unsubscribe
}, [])
```

`useRealtimeStore.subscribe()` (Zustand 바닐라 API)는 React 렌더 사이클 **바깥**에서 동작한다. Supabase가 30ms마다 이벤트를 전송하더라도 컴포넌트 리렌더는 단 한 번도 발생하지 않으며, `combinedDataRef`는 항상 최신 상태를 유지한다. 300ms 페인트 타이머가 이 ref를 읽어 Chart.js를 업데이트하는 구조가 완성된다.

---

<a id="troubleshooting"></a>
## 4. 핵심 트러블슈팅 케이스 스터디

### Case 1: IntersectionObserver 무한 API 페칭 루프

**현상**

네트워크 탭에서 `history?cursor=...` 요청이 0ms 간격으로 수십 개 발화되는 DDoS 수준의 무한 루프가 관측되었다. 스크롤이 왼쪽 끝에 닿는 순간 요청이 폭발적으로 쏟아지며 API가 마비되는 수준이었다.

**원인 분석**

```
Observer 발화 → isFetchingNextPage 검사(false) → fetchNextPage() 호출
Observer 재발화 → isFetchingNextPage 검사(여전히 false!) → fetchNextPage() 또 호출
                                ↑
            React 상태 배치 업데이트 반영 전 비동기 갭(~수십 ms)
```

`isFetchingNextPage`는 React 상태이기 때문에 `fetchNextPage()` 호출 직후 즉시 `true`로 바뀌지 않는다. 이 갭 동안 sentinel이 계속 뷰포트에 노출되어 있으면 Observer가 동수의 콜백을 실행한다. 기존의 `!isFetchingNextPage` 단일 가드만으로는 이 갭을 막을 수 없었다.

**해결: 동기 락(Locking) 메커니즘 도입**

```ts
const isComponentFetchingRef = useRef(false)  // 동기 락 플래그

// Observer 콜백
if (isFetchingNextPage || isComponentFetchingRef.current) return  // 이중 가드

isComponentFetchingRef.current = true  // 동기적으로 즉각 잠금
fetchNextPage()
```

`isComponentFetchingRef`는 `fetchNextPage()` 호출과 동시에 **동기적으로** `true`가 된다. Observer가 아무리 빠르게 재발화해도 첫 번째 이후의 모든 호출은 이 ref 체크에서 차단된다.

**락 해제 3중 안전망**

| 경로 | 시점 | 조건 |
|------|------|------|
| 정상 (데이터 증가) | `allMetrics` effect 내 2nd rAF — 스크롤 복원 DOM 정착 후 | `addedLen > 0` |
| 정상 (데이터 동일) | `allMetrics` effect 조기 return 직전 | `addedLen <= 0` |
| 예외 안전망 | `isFetchingNextPage → false` 후 `PAINT_MS × 2` (600ms) | 오류·취소로 `allMetrics` 미변경 시 |

정상 경로(~330ms)보다 안전망(600ms)이 항상 늦게 실행되므로 중복 해제는 무해하다.

---

### Case 2: 화면 백화 현상 (스크롤 복원 타이밍 오차)

**현상**

과거 데이터 페이지가 로드될 때 차트가 순간적으로 하얗게 비어 보이는 백화 현상이 반복적으로 발생했다.

**원인 분석**

스크롤 복원 로직이 `addedLen * PX_PER_SLOT`이라는 **추정값**을 사용했고, `setTimeout(PAINT_MS + 50)`의 대기 시간이 실제 Chart.js 렌더 완료보다 빠를 수 있었다.

```
Chart.js 렌더 체인:
  chartWrapperRef.style.width 변경
    → Chart.js ResizeObserver 감지 (비동기)
      → canvas 재드로
        → 브라우저 레이아웃 확정
          → scrollWidth 신뢰 가능
```

이 체인 전체가 완료되기 전에 `scrollLeft`를 복원하면, 존재하지 않는 픽셀로 이동하여 차트가 빈 영역을 보여주는 백화가 발생한다.

**해결: 실제 scrollWidth 델타 + 이중 rAF**

```ts
setTimeout(() => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {  // 2차 rAF: 레이아웃 완전 확정 시점
      const delta = scroller.scrollWidth - prevScrollWidth  // 추정 아닌 실측
      scroller.scrollLeft = Math.max(0, savedScroll + delta)
    })
  })
}, PAINT_MS)
```

- `setTimeout(PAINT_MS)`: 페인트 타이머가 wrapper 폭을 실제로 늘릴 때까지 대기
- `rAF × 1`: Chart.js ResizeObserver 및 canvas 재드로 완료 대기
- `rAF × 2`: 브라우저 레이아웃 확정 및 `scrollWidth` 신뢰 가능 시점
- `prevScrollWidth` **실측 델타**: `PX_PER_SLOT` 추정을 폐기하고 DOM의 실제 변화량을 사용

---

### Case 3: 차트 범례 가출 현상

**현상**

수평 스크롤로 차트를 왼쪽으로 당기면 "Seoul Web", "Seoul DB", "Jeju AI" 범례가 canvas와 함께 화면 왼쪽으로 사라졌다.

**원인 분석**

Chart.js 내장 legend는 canvas **내부**에 픽셀로 그려진다. 가로로 확장되는 canvas(`chartWrapperRef.style.width`)가 스크롤되면 canvas의 모든 내용물, 즉 범례까지 함께 이동한다.

**해결: Chart.js 내장 legend 비활성화 + HTML 정적 범례 격리**

```ts
// RealtimeChart.config.ts
plugins: { legend: { display: false } }  // 내장 legend 완전 비활성
```

```tsx
{/* 스크롤 컨테이너 완전 외부 — flex shrink-0으로 고정 */}
<div className="shrink-0 flex items-center gap-5 px-1">
  {SERVER_IDS.map(id => (
    <div key={id} className="flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-xs text-slate-300">{label}</span>
    </div>
  ))}
</div>
```

범례를 `scrollerRef` **바깥** 상위 플렉스 컨테이너의 `shrink-0` 레이어에 배치하면, 차트가 아무리 넓어지고 스크롤되어도 범례는 항상 제자리를 지킨다. `flex-col` 구조로 전환하여 범례(`shrink-0`)와 차트 영역(`flex-1 min-h-0`)을 수직으로 분리했다.

---

<a id="architecture"></a>
## 5. 아키텍처 성과 및 설계 원칙

### 하이브리드 데이터 레이어 구조

```
┌─────────────────────────────────────────────────────┐
│                  RealtimeChart.tsx                  │
│                                                     │
│  ┌─────────────────┐    ┌──────────────────────┐   │
│  │ TanStack Query   │    │   Zustand Store      │   │
│  │ (과거 이력)       │    │ (실시간 피드)          │   │
│  │ allMetrics[]     │    │ realtimeSlots[]      │   │
│  │ newest→oldest    │    │ oldest→newest        │   │
│  └────────┬────────┘    └──────────┬───────────┘   │
│           │  allMetricsRef          │  realtimeSlotsRef  │
│           └──────────┬─────────────┘                │
│                      ▼                              │
│            computeCombined()                        │
│            Map<timestamp, CombinedSlot>             │
│            → oldest→newest 정렬                     │
│                      │                              │
│                 combinedDataRef                     │
│                      │                              │
│                      ▼ (300ms)                      │
│              페인트 타이머 → Chart.js                 │
└─────────────────────────────────────────────────────┘
```

### Zero Re-render 철학

이 세션의 핵심 설계 원칙은 **React 리렌더링을 최소화하는 ref-first 아키텍처**다.

| 데이터 흐름 | React 상태 사용 | 리렌더 발생 |
|-------------|----------------|------------|
| Zustand 실시간 슬롯 변화 | ✗ (`.subscribe()`) | **0회** |
| combinedData 재계산 | ✗ (ref 직접 갱신) | **0회** |
| Chart.js 데이터 동기화 | ✗ (setInterval) | **0회** |
| 캔버스 폭 조정 | ✗ (DOM 직접 조작) | **0회** |
| 로딩 인디케이터 | ✗ (ref.style) | **0회** |

`useRealtimeStore(s => s.slots)` (React hook) 대신 `useRealtimeStore.subscribe()` (Zustand 바닐라 API)를 선택한 것이 이 성과의 핵심이다. Mock 모드에서 30ms마다 발생하는 3서버 동시 이벤트, 즉 초당 최대 100회의 상태 변화가 발생해도 React 컴포넌트는 침묵을 유지한다.

### 스크롤 보존 타이밍 상태 머신

```
fetchNextPage() 호출
      │
      ├─ isComponentFetchingRef = true  (즉각, 동기)
      │
      ▼
  [isFetchingNextPage: true]
      │
      ▼  allMetrics 변경 감지
  allMetricsRef 갱신
  combinedDataRef 재계산
      │
      ▼  setTimeout(PAINT_MS)
  페인트 타이머가 wrapper 폭 갱신 보장
      │
      ▼  requestAnimationFrame ×1
  Chart.js ResizeObserver 완료 대기
      │
      ▼  requestAnimationFrame ×2
  scrollWidth 실측 델타 적용
  isComponentFetchingRef = false  (정상 경로 락 해제)
```

---

<a id="summary"></a>
## 6. 최종 성과 요약

### 구현 완료 목록

| 번호 | 항목 | 파일 |
|------|------|------|
| ① | 커서 기반 페이징 Mock API | `app/api/metrics/history/route.ts` |
| ② | `useInfiniteQuery` 커스텀 훅 | `src/hooks/useMetricsHistory.ts` |
| ③ | TanStack Query Provider | `src/components/common/QueryProvider.tsx` |
| ④ | Zustand 실시간 스토어 | `src/store/useRealtimeStore.ts` |
| ⑤ | Map 기반 하이브리드 병합 | `computeCombined()` in `RealtimeChart.tsx` |
| ⑥ | IntersectionObserver 이중 락 | `isComponentFetchingRef` in `RealtimeChart.tsx` |
| ⑦ | 스크롤 백화 방지 (3중 타이밍) | `setTimeout + rAF×2` in `RealtimeChart.tsx` |
| ⑧ | HTML 정적 범례 분리 | `shrink-0` flex layer in `RealtimeChart.tsx` |

### 정량적 성과

- **API 중복 요청**: 수십 건/회 → **1건/회** (이중 가드 락으로 100% 차단)
- **컴포넌트 리렌더**: 실시간 데이터 인입 시 **0회** (`.subscribe()` 바닐라 API 전환)
- **스크롤 복원 오차**: `PX_PER_SLOT` 추정 → **실측 `scrollWidth` 델타** (오차 제로)
- **타임스탬프 중복**: Map 기반 dedup으로 과거-실시간 경계 데이터 **완전 단일화**

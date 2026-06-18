# Session 6 Work Log — 다중 서버 필터링 스위칭 & Y축 LERP 동적 스케일링, 관심사 분리 리팩토링

---

## 목차

1. [세션 개요](#overview)
2. [구현 내역 — Step 17-1: 다중 서버 필터링 스위치](#step17-filter)
3. [구현 내역 — Step 17-2: Y축 LERP 동적 스케일링](#step17-lerp)
4. [핵심 트러블슈팅 케이스 스터디](#troubleshooting)
5. [아키텍처 리팩토링 — 관심사 분리 3분할](#refactoring)
6. [최종 성과 요약](#summary)

---

<a id="overview"></a>
## 1. 세션 개요

### 배경

Session 5에서 완성된 하이브리드 데이터 레이어(TanStack Query 과거 이력 + Zustand 실시간 피드)는 `RealtimeChart.tsx` 단일 파일 안에 400줄이 넘는 모든 로직을 담고 있었다. 렌더링 유틸, 사이드 이펙트, DOM 조작, Chart.js 초기화, 데이터 병합이 한 곳에 얽혀 있어 기능 추가 비용이 선형적으로 증가하는 구조적 부채를 안고 있었다.

동시에 뷰포트에 표시된 데이터의 실제 범위에 따라 Y축이 살아 움직이는 동적 스케일링이 없었다. 3개 서버 CPU가 모두 60~70% 대역에 밀집해 있어도 Y축은 0~100으로 고정된 채 데이터가 가운데 밴드에 납작하게 찌그러져 보이는 시인성 문제가 상시 존재했다.

### 목표

- **Step 17-1 (필터링)**: 범례를 클릭 가능한 토글 스위치로 바꿔 서버별 시계열을 독립적으로 on/off하고, 활성 서버 집합만으로 Y축 도메인을 재계산한다.
- **Step 17-2 (동적 스케일링)**: 페인트 타이머 내부에서 직접 LERP를 구현하여, 데이터 범위가 변할 때 Y축 경계가 뚝뚝 끊기지 않고 부드럽게 수렴하도록 한다.
- **리팩토링**: 비대해진 단일 파일을 렌더링 유틸, 사이드 이펙트 훅, 선언형 UI로 완전히 분리한다.

### 기술 스택

| 레이어 | 기술 |
|--------|------|
| Y축 스케일링 | 수동 LERP(`ys.min += (tMin - ys.min) * 0.50`) |
| 서버 필터 상태 | `useState` + `useRef` 미러 (UI 리렌더와 페인트 루프 분리) |
| 차트 렌더링 | Chart.js `update('none')` — 내장 애니메이션 완전 비활성 |
| 고정 Y축 | 별도 `<canvas>` — `chart.scales['y'].ticks` 좌표 직접 복제 |
| 관심사 분리 | `utils.ts` / `useChartPaint.ts` / `RealtimeChart.tsx` 3분할 |

---

<a id="step17-filter"></a>
## 2. 구현 내역 — Step 17-1: 다중 서버 필터링 스위치

### 2-1. 설계 원칙: 상태 이중화 (useState + useRef 미러)

필터 상태를 어디에 두느냐가 핵심 결정이었다. 두 가지 소비자가 동시에 존재하기 때문이다.

| 소비자 | 필요한 것 | 부적합한 방식 |
|--------|-----------|--------------|
| 범례 버튼 UI | React 리렌더(상태 변화 반영) | `useRef`만 사용하면 UI 갱신 없음 |
| 300ms 페인트 타이머 | 동기 읽기, 리렌더 없이 즉시 반영 | `useState`만 사용하면 클로저 구 상태 캡처 |

해결: `useState`로 UI 리렌더를 보장하고, `useRef`로 페인트 루프에 클로저 없이 최신값을 노출한다. `toggleServer`가 두 상태를 하나의 트랜잭션에서 동기 갱신한다.

```ts
// hooks/useChartPaint.ts
const [visibleServers, setVisibleServers] = useState<Record<string, boolean>>(
  () => Object.fromEntries(SERVER_IDS.map(id => [id, true])),
)
const visibleServersRef = useRef(visibleServers)

const toggleServer = useCallback((id: string) => {
  setVisibleServers(prev => {
    const next = { ...prev, [id]: !prev[id] }
    visibleServersRef.current = next  // ref 동기 갱신 — 페인트 타이머에 즉시 반영
    return next
  })
}, [])
```

### 2-2. 범례 UI — 인터랙티브 토글 버튼

기존 정적 범례(색상 점 + 텍스트)를 클릭 가능한 토글 버튼으로 교체했다. Chart.js 내장 legend는 이전 세션에서 이미 `display: false`로 제거했으므로, HTML 레이어에서만 인터랙션을 구현하면 된다.

활성 상태에서는 `bg-slate-800/60`, 비활성에서는 `opacity-40 bg-transparent`로 시각적 피드백을 제공하며, 색상 점도 비활성 시 `#475569`로 채도를 제거해 "꺼진" 느낌을 강화한다.

```tsx
// RealtimeChart.tsx
<button
  key={id}
  type="button"
  onClick={() => toggleServer(id)}
  className={[
    'flex items-center gap-1.5 px-2 py-0.5 rounded',
    'cursor-pointer select-none transition-all duration-150',
    isOn
      ? 'bg-slate-800/60 hover:bg-slate-700/60'
      : 'bg-transparent hover:bg-slate-800/40 opacity-40',
  ].join(' ')}
>
  <span
    className="w-3 h-3 rounded-sm shrink-0 transition-colors duration-150"
    style={{ backgroundColor: isOn ? color : '#475569' }}
  />
  <span className="text-xs text-slate-300">{label}</span>
</button>
```

### 2-3. 데이터셋 가시성 동기화

페인트 타이머 안에서 `chart.setDatasetVisibility()`를 호출해 Chart.js 레벨의 가시성을 동기화한다. Chart.js는 숨겨진 데이터셋을 Y축 범위 계산에서 자동으로 제외하지 않으므로, Y축 도메인 계산도 `visibleServersRef`로 필터링된 값만 참조한다.

```ts
// 페인트 타이머 내부 (hooks/useChartPaint.ts)
const visible = visibleServersRef.current

// Y축 도메인: 활성 서버 데이터만 포함
for (const slot of combined) {
  for (let j = 0; j < SERVER_IDS.length; j++) {
    const sid = SERVER_IDS[j]
    if (!(visible[sid] ?? true)) continue  // 비활성 서버 건너뜀
    const cpu = slot.servers[sid]?.cpu_usage
    if (cpu == null) continue
    if (cpu < yMin) yMin = cpu
    if (cpu > yMax) yMax = cpu
  }
}

// 데이터셋 가시성 적용
SERVER_IDS.forEach((id, j) => {
  chart.setDatasetVisibility(j, visible[id] ?? true)
})
```

---

<a id="step17-lerp"></a>
## 3. 구현 내역 — Step 17-2: Y축 LERP 동적 스케일링

### 3-1. 문제: Chart.js 애니메이션 시스템의 구조적 한계

Chart.js의 내장 애니메이션 시스템은 개별 데이터 포인트의 위치 변화를 보간하는 데 최적화되어 있다. **Y축 `min`/`max` 도메인 값 자체를 부드럽게 보간하는 기능은 내장되어 있지 않다.**

이 프로젝트는 실시간 차트의 특성상 `chart.update('none')` 옵션이 필수다. `update('none')` 없이는 매 300ms마다 전체 애니메이션이 재실행되어 데이터가 0에서 목표값으로 날아오는 시각적 노이즈가 발생하기 때문이다.

결과적으로 두 가지 선택지가 충돌한다.

| 선택 | 현상 |
|------|------|
| `update('none')` + 도메인 즉시 적용 | 눈금이 300ms마다 뚝뚝 점프 — 운영 정보 혼란 |
| `update('none')` 제거 | 실시간 데이터 인입 시 전체 차트가 반복적으로 날아오는 시각적 노이즈 |

### 3-2. 해결: 페인트 타이머 내부의 수동 LERP

Chart.js에 의존하지 않고, **300ms 페인트 루프 틱마다 직접 선형 보간(LERP)을 수행**하는 방법으로 해결한다. 목표값과의 차를 매 틱 50% 감산하는 지수적 감쇠(exponential decay) 패턴으로, 초기에는 빠르게 수렴하고 목표에 가까워질수록 느려지는 쫀득한 이징 효과를 얻는다.

```ts
// hooks/useChartPaint.ts — 페인트 타이머 내부
const ys = yScaleRef.current

// 스냅 가드: 잔여 거리 0.1 미만이면 목표값으로 즉시 스냅
// 없으면 ys.min 이 tMin에 무한히 수렴하며 소수점 연산이 영원히 지속됨
ys.min = Math.abs(tMin - ys.min) < 0.1 ? tMin : ys.min + (tMin - ys.min) * SCALE_LERP
ys.max = Math.abs(tMax - ys.max) < 0.1 ? tMax : ys.max + (tMax - ys.max) * SCALE_LERP

const yAxis = chart.options.scales?.['y']
if (yAxis) {
  yAxis.min = ys.min
  yAxis.max = ys.max
}
```

`yScaleRef`는 React 상태가 아닌 `useRef`로 관리되므로 LERP 중간값이 리렌더 없이 틱 사이에 정확히 보존된다. `useState`로 관리하면 매 틱마다 리렌더가 발생하고, 무엇보다 React 배치 업데이트 타이밍에 따라 중간값이 누락될 수 있다.

### 3-3. 도메인 경계 정렬: `floorTo5 / ceilTo5`

원시 데이터 min/max를 그대로 도메인으로 쓰면 눈금이 `63.7` → `71.2`처럼 불규칙한 소수점으로 채워진다. 5의 배수로 floor/ceil을 적용해 눈금이 항상 깔끔한 정수로 표시되도록 한다.

```ts
// RealtimeChart.utils.ts
export const floorTo5 = (x: number) => Math.floor(x / 5) * 5
export const ceilTo5  = (x: number) => Math.ceil(x  / 5) * 5

// 페인트 타이머 내부
const span   = yMax - yMin
const margin = Math.max(span * Y_MARGIN_RATIO, Y_MARGIN_MIN)  // 최소 5pt 여백
const tMin   = Math.max(0,   floorTo5(yMin - margin))
const tMax   = Math.min(100, ceilTo5(yMax  + margin))
```

`Y_MARGIN_RATIO = 0.10`으로 현재 범위의 10% 패딩을 추가하되, 범위가 0에 가까울 때도 `Y_MARGIN_MIN = 5`로 최소 여백을 보장한다.

### 3-4. 고정 Y축 별도 캔버스

스크롤 컨테이너 바깥에 별도 `<canvas ref={yAxisCanvasRef}>`를 두어, Chart.js의 Y축 눈금 좌표를 매 틱 직접 복제해 그린다. 차트 캔버스가 가로로 무한히 확장되어도 Y축은 항상 제자리를 지킨다.

```ts
// 페인트 타이머 내부 — chart.scales['y']의 실제 픽셀 좌표를 읽어 복제
const yScale = (chart.scales as Record<string, Scale>)['y']

for (const tick of yScale.ticks) {
  const y = yScale.getPixelForValue(tick.value)
  ctx.fillText(`${Math.round(tick.value)}%`, cw - 6, y)
}
```

`chart.update('none')` 직후의 `yScale.ticks`는 이미 LERP 보간이 적용된 `ys.min / ys.max` 기준으로 재계산되어 있으므로, 고정 Y축 캔버스가 별도 계산 없이 차트 내부 상태와 항상 동기화된다.

---

<a id="troubleshooting"></a>
## 4. 핵심 트러블슈팅 케이스 스터디

### Case 1: 필터 토글 후 Y축이 즉시 반응하지 않는 현상

**현상**

"Seoul DB" 서버를 끄면 Y축 도메인이 즉시 업데이트되지 않고, 다음 페인트 틱(최대 300ms)까지 기다렸다가 변했다.

**원인 분석**

필터 상태가 `useState`로 관리되고, 페인트 타이머는 setInterval 클로저 안에서 생성된 `visibleServers` 상태를 캡처하기 때문이다. 클로저 내부의 `visibleServers`는 타이머가 생성된 시점의 구 값을 참조한다.

**해결: ref 미러를 읽는 페인트 루프**

페인트 타이머가 `visibleServers`(상태)가 아닌 `visibleServersRef.current`(ref)를 읽도록 변경했다. ref는 클로저와 무관하게 항상 최신값을 가리키므로, `toggleServer` 호출 즉시 다음 틱(최대 300ms)에서 새로운 필터 상태가 반영된다. 300ms는 사람이 버튼 클릭 후 체감하기 어려운 지연이므로 허용 범위다.

### Case 2: 서버를 모두 끄면 Y축이 `Infinity`로 폭발하는 현상

**현상**

3개 서버 필터를 모두 off하면 콘솔에 Chart.js 경고가 쏟아지며 Y축 눈금이 사라지거나 `NaN`으로 표시됐다.

**원인 분석**

모든 서버가 비활성이면 `yMin = Infinity`, `yMax = -Infinity` 상태로 `tMin / tMax` 계산에 진입한다. `floorTo5(Infinity - margin) = Infinity`, `ceilTo5(-Infinity + margin) = -Infinity`가 Chart.js에 전달된다.

**해결: 폴백 가드**

```ts
if (!isFinite(yMin)) { yMin = 0; yMax = 100 }
```

활성 서버가 하나도 없을 때 기본 도메인(0~100)으로 폴백한다. 단 한 줄의 가드지만 없으면 Chart.js 전체가 오염된다.

### Case 3: LERP 무한 수렴 연산 병목

**현상**

목표값에 거의 도달한 상태에서도 매 300ms마다 `ys.min += 0.00000000001...`급 연산이 반복됐다. 실제 렌더 변화는 0이지만 `chart.update('none')`은 계속 호출된다.

**원인 분석**

지수적 감쇠(exponential decay) 수렴은 수학적으로 목표값에 무한히 접근할 뿐 **도달하지 않는다.** 정지 조건이 없으면 `ys.min`은 영원히 소수점 아래를 움직이며 매 틱 `chart.update()`를 트리거한다.

**해결: 스냅 가드 (`< 0.1` 임계점)**

```ts
ys.min = Math.abs(tMin - ys.min) < 0.1 ? tMin : ys.min + (tMin - ys.min) * SCALE_LERP
```

잔여 거리가 0.1 미만이면 목표값으로 즉시 스냅한다. 300ms 틱에서 0.1pt 차이는 픽셀로 1px 미만이므로 시각적으로 완전히 무해하다. 이 가드가 없으면 LERP는 대부분의 시간 동안 아무 변화 없는 `chart.update()`를 연속 발화하는 CPU 낭비 루프가 된다.

---

<a id="refactoring"></a>
## 5. 아키텍처 리팩토링 — 관심사 분리 3분할

### 5-1. 분리 전: 400줄짜리 거인

Session 5 이후의 `RealtimeChart.tsx`는 다음 모든 것을 하나의 파일에 담고 있었다.

```
RealtimeChart.tsx (400줄+)
├── 순수 수학 유틸 (LERP 상수, floorTo5, computeCombined ...)
├── Mock 모드 상수 및 generateMockMetric()
├── Chart.js 초기화 및 옵션
├── Supabase 구독 / Mock 인터벌 (사이드 이펙트)
├── Zustand 바닐라 subscribe (사이드 이펙트)
├── IntersectionObserver (사이드 이펙트)
├── 300ms 페인트 타이머 (사이드 이펙트 + 렌더링 로직)
└── JSX 범례 + 차트 레이아웃 (선언형 UI)
```

새로운 기능(동적 스케일링, 필터링)을 추가할수록 엔트로피가 가속적으로 누적됐다. 어느 useEffect가 어느 ref를 소유하는지, 어느 상수가 어느 로직에서 쓰이는지 파악하려면 400줄을 전부 읽어야 했다.

### 5-2. 분리 후: 삼각 편대

```
RealtimeChart.tsx          (100줄)  — 선언형 UI만
  └── useChartPaint.ts     (362줄)  — 사이드 이펙트 전담
        └── RealtimeChart.utils.ts (85줄)  — 렌더링 의존성 0, 순수 로직
```

각 파일의 단일 책임을 엄격히 정의했다.

#### `RealtimeChart.utils.ts` (85줄) — 렌더링 의존성 제로

React, Chart.js, Supabase, Zustand 중 어떤 것도 import하지 않는다. 수학 수식, 상수, 타입, 순수 함수만 존재한다. 이 파일은 Node.js, 브라우저, Jest 어디서든 부작용 없이 실행된다.

```ts
// 레이아웃 상수
export const PX_PER_SLOT    = 40
export const SCALE_LERP     = 0.50
export const Y_MARGIN_RATIO = 0.10
export const Y_MARGIN_MIN   = 5

// 순수 함수
export const floorTo5 = (x: number) => Math.floor(x / 5) * 5
export const ceilTo5  = (x: number) => Math.ceil(x  / 5) * 5

// 병합 알고리즘 (과거 이력 + 실시간 슬롯 → O(n) dedup + 정렬)
export function computeCombined(historical, realtime): CombinedSlot[]
```

#### `hooks/useChartPaint.ts` (362줄) — 사이드 이펙트 전담

모든 `useEffect`, `useRef`, `setInterval`, `IntersectionObserver`, Supabase 채널, Zustand subscribe가 이 파일에 집중된다. `RealtimeChart.tsx`가 렌더링에 필요한 ref와 핸들러만 반환한다.

```ts
export function useChartPaint() {
  // ... 모든 사이드 이펙트와 ref

  return {
    canvasRef, overlayRef, loadingRef,
    scrollerRef, chartWrapperRef, sentinelRef, yAxisCanvasRef,
    visibleServers, toggleServer, handleScroll,
  }
}
```

#### `RealtimeChart.tsx` (100줄) — 100% 선언형 UI

`useChartPaint()` 훅 호출 한 줄로 모든 로직을 위임하고, 반환된 ref와 핸들러를 JSX에 연결하는 역할만 한다. `useEffect`, `useState`, `useRef`는 단 하나도 존재하지 않는다.

```tsx
const RealtimeChart = memo(function RealtimeChart() {
  const {
    canvasRef, overlayRef, loadingRef,
    scrollerRef, chartWrapperRef, sentinelRef, yAxisCanvasRef,
    visibleServers, toggleServer, handleScroll,
  } = useChartPaint()

  return (
    <div className="flex flex-col w-full h-full min-h-0 gap-2">
      {/* 범례 필터 버튼 */}
      {/* 차트 레이아웃 (고정 Y축 + 스크롤 캔버스) */}
    </div>
  )
})
```

---

<a id="summary"></a>
## 6. 최종 성과 요약

### 구현 완료 목록

| 번호 | 항목 | 파일 |
|------|------|------|
| ① | 다중 서버 필터 토글 스위치 (활성/비활성 시각 피드백) | `RealtimeChart.tsx` |
| ② | 필터 상태 이중화 (useState UI + useRef 페인트 루프) | `hooks/useChartPaint.ts` |
| ③ | Y축 LERP 동적 스케일링 (SCALE_LERP = 0.50) | `hooks/useChartPaint.ts` |
| ④ | 도메인 경계 5의 배수 정렬 (floorTo5 / ceilTo5) | `RealtimeChart.utils.ts` |
| ⑤ | LERP 스냅 가드 (잔여 거리 < 0.1 → 즉시 스냅) | `hooks/useChartPaint.ts` |
| ⑥ | 활성 서버 전무 시 Infinity 폴백 가드 | `hooks/useChartPaint.ts` |
| ⑦ | 순수 유틸 격리 (React 의존성 0) | `RealtimeChart.utils.ts` |
| ⑧ | 사이드 이펙트 전담 커스텀 훅 | `hooks/useChartPaint.ts` |
| ⑨ | 선언형 UI 컴포넌트로 다이어트 (단일 훅 호출 구조) | `RealtimeChart.tsx` |

### 정량적 성과

| 지표 | 리팩토링 전 | 리팩토링 후 |
|------|------------|------------|
| 단일 파일 최대 줄 수 | **400줄+** | **362줄** (`useChartPaint.ts`) |
| UI 컴포넌트 줄 수 | **400줄+** | **100줄** (`RealtimeChart.tsx`) |
| 순수 유틸 테스트 가능성 | 불가 (React 혼재) | **완전 격리** — 렌더 없이 단독 테스트 가능 |
| Y축 업데이트 방식 | 즉시 점프 (300ms 뚝뚝) | **LERP 수렴** (매 틱 50% 감쇠) |
| 필터 off 시 Y축 반응 | 정의 없음 | **활성 서버 집합 기준 즉시 재계산** |

### 설계 원칙 회고

이번 세션의 핵심 통찰은 **"Chart.js와 싸우지 않는다"** 이다. Chart.js의 내장 애니메이션을 Y축 스케일링에 활용하려는 시도는 `update('none')` 제약과 정면으로 충돌한다. 라이브러리가 제공하지 않는 것을 우회하는 것보다, **페인트 루프 안에서 직접 LERP를 구현하는 것이 더 단순하고 예측 가능한 해법**이었다.

관심사 분리 또한 같은 맥락이다. 리팩토링 이전에는 "지금 어디를 고쳐야 하나?"를 알기 위해 400줄을 전부 스캔해야 했다. 분리 이후에는 파일 이름이 곧 수정 범위다. 수식이 틀렸으면 `utils.ts`, 사이드 이펙트가 잘못됐으면 `useChartPaint.ts`, 레이아웃이 어색하면 `RealtimeChart.tsx`만 열면 된다.

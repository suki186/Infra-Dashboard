// ─── metrics.ts — 메트릭 버퍼 도메인 공유 타입 ────────────────────────────────
// useMetricsBuffer 훅 · RealtimeChart 가 공통으로 참조하는 타입.
// 런타임 코드 없는 순수 타입 파일이다.

import type { ServerMetric } from '@/src/config/infrastructure'

/** X축 1슬롯 단위 — HH:MM:SS 레이블 + 서버별 CPU 값 맵 */
export type TimeSlot = {
  time:   string                  // HH:MM:SS (사전식 정렬 = 시간순)
  values: Record<string, number>  // server_id → cpu_usage
}

/** useMetricsBuffer 훅의 공개 반환 인터페이스 */
export type MetricsBuffer = {
  addDataToBuffer: (data: ServerMetric) => void
  sharedBufferRef: { current: TimeSlot[] }
}

// ─── useMetricsHistory — 페이지 기반 무한 스크롤 메트릭 히스토리 훅 ──────────────
// apps/server의 GET /api/metrics/history(Prisma 기반 실제 DB 조회)를 useInfiniteQuery로
// 감싼다. 백엔드는 (server × tick) 단위의 평탄한 row 배열을 page/limit으로 반환하므로,
// 여기서 timestamp 기준으로 그룹핑해 차트가 기대하는 HistoryPoint[] 형태로 변환한다.

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { useMemo } from 'react'
import { SERVER_IDS } from '@/src/config/infrastructure'

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type ServerSnapshot = {
  cpu_usage:    number
  memory_usage: number
  disk_io:      number
  status:       string
}

export type HistoryPoint = {
  timestamp: string
  servers:   Record<string, ServerSnapshot>
}

// apps/server GET /api/metrics/history 응답의 row 하나
type MetricRow = {
  id:          string
  serverId:    string
  status:      string | null
  cpuUsage:    number | null
  memoryUsage: number | null
  diskIo:      number | null
  createdAt:   string
}

type MetricsHistoryResponse = {
  data:  MetricRow[]
  page:  number
  limit: number
  total: number
}

type HistoryPage = {
  points:   HistoryPoint[]
  page:     number
  hasMore:  boolean
}

// ─── 상수 ────────────────────────────────────────────────────────────────────

// 데모 데이터는 tick마다 서버 전체(SERVER_IDS)가 동시에 기록되므로,
// "포인트(timestamp) 개수" 기준 limit을 "row 개수" 기준으로 환산할 때 사용한다.
const ROWS_PER_POINT = Math.max(SERVER_IDS.length, 1)

const DEFAULT_API_URL = 'http://localhost:3001'

function apiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL
}

// ─── row → HistoryPoint 그룹핑 ────────────────────────────────────────────────
// 백엔드는 createdAt desc(+id desc, tie-break)로 정렬해 반환하므로,
// Map의 삽입 순서를 그대로 유지하면 newest → oldest 순서가 보존된다.
function groupRowsByTimestamp(rows: MetricRow[]): HistoryPoint[] {
  const map = new Map<string, HistoryPoint>()

  for (const row of rows) {
    let point = map.get(row.createdAt)
    if (!point) {
      point = { timestamp: row.createdAt, servers: {} }
      map.set(row.createdAt, point)
    }
    point.servers[row.serverId] = {
      cpu_usage:    row.cpuUsage    ?? 0,
      memory_usage: row.memoryUsage ?? 0,
      disk_io:      row.diskIo      ?? 0,
      status:       row.status      ?? '',
    }
  }

  return Array.from(map.values())
}

// ─── fetcher ─────────────────────────────────────────────────────────────────

async function fetchHistoryPage(page: number, pointsLimit: number): Promise<HistoryPage> {
  const rowsLimit = pointsLimit * ROWS_PER_POINT
  const params = new URLSearchParams({ page: String(page), limit: String(rowsLimit) })

  const res = await fetch(`${apiUrl()}/api/metrics/history?${params}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }

  const body: MetricsHistoryResponse = await res.json()
  const points  = groupRowsByTimestamp(body.data)
  const hasMore = body.page * body.limit < body.total

  return { points, page: body.page, hasMore }
}

// ─── 훅 공개 옵션 ─────────────────────────────────────────────────────────────

type UseMetricsHistoryOptions = {
  limit?: number
  enabled?: boolean
}

// ─── 훅 ──────────────────────────────────────────────────────────────────────

export function useMetricsHistory({ limit = 50, enabled = true }: UseMetricsHistoryOptions = {}) {
  const query = useInfiniteQuery<
    HistoryPage,
    Error,
    InfiniteData<HistoryPage>,
    string[],
    number
  >({
    queryKey:         ['metrics-history', String(limit)],
    queryFn:          ({ pageParam }) => fetchHistoryPage(pageParam, limit),
    initialPageParam: 1,

    // 다음 page 번호 → 다음 pageParam; hasMore가 false면 undefined로 페이지 끝을 알린다.
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.page + 1 : undefined),

    enabled,
  })

  // 전체 페이지 배열을 시간 역순(newest → oldest)으로 평탄화
  const allMetrics = useMemo<HistoryPoint[]>(
    () => query.data?.pages.flatMap((page) => page.points) ?? [],
    [query.data],
  )

  return {
    // ── 원본 InfiniteQuery 상태 ──────────────────────────────────────────────
    fetchNextPage:    query.fetchNextPage,
    hasNextPage:      query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading:        query.isLoading,
    isError:          query.isError,
    error:            query.error,

    // ── 가공 데이터 ───────────────────────────────────────────────────────────
    // 모든 페이지를 flatten한 HistoryPoint[]  (newest → oldest)
    allMetrics,

    // 전체 로드된 포인트 수 (디버깅·UI 표시용)
    totalCount: allMetrics.length,
  }
}

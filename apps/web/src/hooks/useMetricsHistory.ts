// ─── useMetricsHistory — 커서 기반 무한 스크롤 메트릭 히스토리 훅 ──────────────
// /api/metrics/history 엔드포인트를 useInfiniteQuery로 감싸며,
// 모든 페이지를 플래트닝한 allMetrics 배열을 함께 반환한다.

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { useMemo } from 'react'

// ─── 타입 ────────────────────────────────────────────────────────────────────

export type ServerSnapshot = {
  cpu_usage:    number
  memory_usage: number
  disk_io:      number
  network_in:   number
  network_out:  number
  status:       'healthy' | 'warning' | 'critical'
}

export type HistoryPoint = {
  timestamp: string
  servers:   Record<string, ServerSnapshot>
}

type HistoryPage = {
  data:       HistoryPoint[]
  nextCursor: string | null
  limit:      number
}

// ─── fetcher ─────────────────────────────────────────────────────────────────

async function fetchHistoryPage(cursor: string | null, limit: number): Promise<HistoryPage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)

  const res = await fetch(`/api/metrics/history?${params}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
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
    string | null
  >({
    queryKey:         ['metrics-history', String(limit)],
    queryFn:          ({ pageParam }) => fetchHistoryPage(pageParam, limit),
    initialPageParam: null,

    // API 응답의 nextCursor → 다음 pageParam; null이면 페이지 끝
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,

    enabled,
  })

  // 전체 페이지 배열을 시간 역순(newest → oldest)으로 평탄화
  const allMetrics = useMemo<HistoryPoint[]>(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
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

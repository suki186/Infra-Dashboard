// ─── GET /api/metrics/history — 커서 기반 페이징 가상 시계열 메트릭 ────────────
// 쿼리 스트링: cursor (ISO 타임스탬프, 옵션) · limit (기본값 50)
// cursor 있으면 해당 시각 이전 데이터, 없으면 현재 기준 최신 데이터를 반환.
// nextCursor: 반환된 데이터 중 가장 오래된 타임스탬프 (다음 페이지 요청에 사용)

import { SERVER_IDS } from '@/src/config/infrastructure'

const INTERVAL_MS = 10_000  // 데이터 포인트 간격 10초

type ServerSnapshot = {
  cpu_usage:    number
  memory_usage: number
  disk_io:      number
  network_in:   number
  network_out:  number
  status:       string
}

type HistoryPoint = {
  timestamp: string
  servers:   Record<string, ServerSnapshot>
}

// 타임스탬프 시드 기반 결정론적 난수 — 같은 시각이면 항상 같은 값 반환
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10_000
  return x - Math.floor(x)
}

function generateSnapshot(serverId: string, ts: number): ServerSnapshot {
  // 서버별·지표별로 시드를 분산시켜 독립적인 파형 생성
  const idSeed = serverId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  const base   = ts / 1_000

  const cpu     = 20 + seededRandom(base * 0.7  + idSeed)       * 60
  const memory  = 30 + seededRandom(base * 0.3  + idSeed + 1)   * 50
  const diskIo  =  5 + seededRandom(base * 1.1  + idSeed + 2)   * 95
  const netIn   =  1 + seededRandom(base * 0.9  + idSeed + 3)   * 500
  const netOut  =  1 + seededRandom(base * 1.3  + idSeed + 4)   * 300

  const status = cpu > 85 || memory > 90 ? 'critical'
               : cpu > 70 || memory > 75 ? 'warning'
               : 'healthy'

  return {
    cpu_usage:    Math.round(cpu    * 10) / 10,
    memory_usage: Math.round(memory * 10) / 10,
    disk_io:      Math.round(diskIo * 10) / 10,
    network_in:   Math.round(netIn  * 10) / 10,
    network_out:  Math.round(netOut * 10) / 10,
    status,
  }
}

function buildPage(anchorMs: number, limit: number): HistoryPoint[] {
  // anchorMs 기준으로 과거 방향으로 limit개 포인트 생성 (newest → oldest)
  return Array.from({ length: limit }, (_, i) => {
    const ts  = anchorMs - i * INTERVAL_MS
    const iso = new Date(ts).toISOString()
    const servers: Record<string, ServerSnapshot> = {}
    for (const id of SERVER_IDS) {
      servers[id] = generateSnapshot(id, ts)
    }
    return { timestamp: iso, servers }
  })
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const cursorParam = searchParams.get('cursor')
  const limitParam  = searchParams.get('limit')
  const limit       = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200)

  // cursor가 있으면 해당 시각의 한 포인트 이전부터, 없으면 현재 시각부터 시작
  let anchorMs: number
  if (cursorParam) {
    const parsed = Date.parse(cursorParam)
    if (isNaN(parsed)) {
      return Response.json({ error: 'cursor가 유효한 ISO 타임스탬프가 아닙니다.' }, { status: 400 })
    }
    // cursor 포인트 자체는 이전 페이지에 포함됐으므로 한 인터벌 더 과거로
    anchorMs = parsed - INTERVAL_MS
  } else {
    // 현재 시각을 10초 단위로 버림하여 결정론적 최신 포인트 확보
    anchorMs = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS
  }

  const data       = buildPage(anchorMs, limit)
  const oldest     = data[data.length - 1]
  const nextCursor = oldest ? oldest.timestamp : null

  return Response.json({ data, nextCursor, limit })
}

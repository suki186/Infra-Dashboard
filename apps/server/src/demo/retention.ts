// ─── DEMO_MODE 데이터 정리(retention) 스케줄러 ────────────────────────────────
// DEMO_MODE는 서버 3대분 메트릭/로그를 계속 생성해 Supabase DB에 쌓기만 하므로,
// 방치하면 무료 티어 DB 용량을 무한정 소모한다. 이 모듈은 일정 주기(기본 10분)마다
// DATA_RETENTION_HOURS(기본 24시간)보다 오래된 row를 infrastructure_metrics/
// infrastructure_logs에서 deleteMany로 삭제한다.
//
// 24시간을 기본값으로 잡은 이유: /api/metrics/history 무한 스크롤이 과거를 계속
// 거슬러 올라가는 기능이므로, retention을 너무 짧게 잡으면(예: 1시간) 스크롤이
// 금방 끝에 도달해 "무한 스크롤"의 가치가 체감되지 않는다. 24시간은 DEMO_MODE의
// 기본 1초 tick 기준으로도 Supabase 무료 티어(500MB) 안에서 안전한 수준이다.
import type { PrismaClient } from '@prisma/client';

export interface RetentionDeps {
  prisma: {
    infrastructureMetric: Pick<PrismaClient['infrastructureMetric'], 'deleteMany'>;
    infrastructureLog: Pick<PrismaClient['infrastructureLog'], 'deleteMany'>;
  };
  retentionHours?: number;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10분

function resolveRetentionHours(deps: RetentionDeps): number {
  if (deps.retentionHours !== undefined) return deps.retentionHours;
  const envHours = Number(process.env.DATA_RETENTION_HOURS);
  return Number.isFinite(envHours) && envHours > 0 ? envHours : DEFAULT_RETENTION_HOURS;
}

function resolveIntervalMs(deps: RetentionDeps): number {
  if (deps.intervalMs !== undefined) return deps.intervalMs;
  // DATA_RETENTION_INTERVAL_MS: 로컬에서 짧은 주기로 정리 동작을 확인하고 싶을 때만
  // 쓰는 내부용 오버라이드. 운영 환경에서는 기본 10분이면 충분해 .env.example에는
  // 문서화하지 않는다 (DEMO_INTERVAL_MS와 동일한 관례).
  const envMs = Number(process.env.DATA_RETENTION_INTERVAL_MS);
  return Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS;
}

export interface PruneResult {
  cutoff:         string;
  deletedMetrics: number;
  deletedLogs:    number;
}

export async function pruneOldData(deps: RetentionDeps, now: Date = new Date()): Promise<PruneResult> {
  const retentionHours = resolveRetentionHours(deps);
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);

  const [metrics, logs] = await Promise.all([
    deps.prisma.infrastructureMetric.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    deps.prisma.infrastructureLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  return { cutoff: cutoff.toISOString(), deletedMetrics: metrics.count, deletedLogs: logs.count };
}

export function createRetentionScheduler(deps: RetentionDeps) {
  const intervalMs = resolveIntervalMs(deps);

  let timer: NodeJS.Timeout | undefined;

  function tick(): void {
    pruneOldData(deps).catch((err) => deps.onError?.(err));
  }

  function start(): void {
    if (timer) return;
    tick(); // 시작 시 한 번 즉시 정리 — 10분을 기다리지 않고 바로 오래된 row 정리
    timer = setInterval(tick, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { start, stop };
}

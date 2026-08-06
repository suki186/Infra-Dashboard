import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRetentionScheduler, pruneOldData } from './retention';

function buildPrismaMock() {
  return {
    infrastructureMetric: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
    infrastructureLog: { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) },
  };
}

describe('pruneOldData', () => {
  afterEach(() => {
    delete process.env.DATA_RETENTION_HOURS;
  });

  it('deletes rows older than the default 24h retention window', async () => {
    const prisma = buildPrismaMock();
    const now = new Date('2026-08-07T12:00:00.000Z');

    const result = await pruneOldData({ prisma }, now);

    const expectedCutoff = new Date('2026-08-06T12:00:00.000Z');
    expect(prisma.infrastructureMetric.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff } },
    });
    expect(prisma.infrastructureLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff } },
    });
    expect(result).toEqual({
      cutoff: expectedCutoff.toISOString(),
      deletedMetrics: 3,
      deletedLogs: 5,
    });
  });

  it('honors an explicit retentionHours override', async () => {
    const prisma = buildPrismaMock();
    const now = new Date('2026-08-07T12:00:00.000Z');

    await pruneOldData({ prisma, retentionHours: 1 }, now);

    const expectedCutoff = new Date('2026-08-07T11:00:00.000Z');
    expect(prisma.infrastructureMetric.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff } },
    });
  });

  it('falls back to DATA_RETENTION_HOURS env var when no explicit override is given', async () => {
    process.env.DATA_RETENTION_HOURS = '6';
    const prisma = buildPrismaMock();
    const now = new Date('2026-08-07T12:00:00.000Z');

    await pruneOldData({ prisma }, now);

    const expectedCutoff = new Date('2026-08-07T06:00:00.000Z');
    expect(prisma.infrastructureMetric.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expectedCutoff } },
    });
  });
});

describe('createRetentionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prunes immediately on start and then on every interval', async () => {
    const prisma = buildPrismaMock();
    const scheduler = createRetentionScheduler({ prisma, intervalMs: 1000 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.infrastructureMetric.deleteMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(prisma.infrastructureMetric.deleteMany).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(prisma.infrastructureMetric.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('reports errors via onError instead of throwing', async () => {
    const prisma = buildPrismaMock();
    prisma.infrastructureMetric.deleteMany.mockRejectedValueOnce(new Error('db down'));
    const onError = vi.fn();

    const scheduler = createRetentionScheduler({ prisma, intervalMs: 1000, onError });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    scheduler.stop();
  });
});

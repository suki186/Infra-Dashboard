import { describe, expect, it } from 'vitest';
import type { LogEntry, ServerMetric } from '@infra-dashboard/shared';
import { createDataBuffer } from './dataBuffer';

function makeMetric(overrides: Partial<ServerMetric> = {}): ServerMetric {
  return {
    serverId: 'kr-seoul-web-01',
    status: 'healthy',
    cpuUsage: 10,
    memoryUsage: 20,
    diskIo: 1,
    createdAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    serverId: 'kr-seoul-web-01',
    level: 'INFO',
    message: 'boot',
    createdAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('dataBuffer', () => {
  it('keeps only the latest metric per serverId until flushed', () => {
    const buffer = createDataBuffer();

    buffer.setMetric(makeMetric({ cpuUsage: 10 }));
    buffer.setMetric(makeMetric({ cpuUsage: 42 }));

    const flushed = buffer.flushMetrics();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.cpuUsage).toBe(42);
  });

  it('tracks the latest metric independently per serverId', () => {
    const buffer = createDataBuffer();

    buffer.setMetric(makeMetric({ serverId: 'server-a', cpuUsage: 10 }));
    buffer.setMetric(makeMetric({ serverId: 'server-b', cpuUsage: 20 }));

    const flushed = buffer.flushMetrics();

    expect(flushed).toHaveLength(2);
    expect(flushed.map((m) => m.serverId).sort()).toEqual(['server-a', 'server-b']);
  });

  it('clears pending metrics after a flush', () => {
    const buffer = createDataBuffer();

    buffer.setMetric(makeMetric());
    buffer.flushMetrics();

    expect(buffer.flushMetrics()).toEqual([]);
  });

  it('keeps only the latest log per serverId until flushed', () => {
    const buffer = createDataBuffer();

    buffer.setLog(makeLog({ message: 'first' }));
    buffer.setLog(makeLog({ message: 'second' }));

    const flushed = buffer.flushLogs();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.message).toBe('second');
  });

  it('clears pending logs after a flush', () => {
    const buffer = createDataBuffer();

    buffer.setLog(makeLog());
    buffer.flushLogs();

    expect(buffer.flushLogs()).toEqual([]);
  });
});

import type { LogEntry, ServerMetric } from '@infra-dashboard/shared';

export function createDataBuffer() {
  const pendingMetrics = new Map<string, ServerMetric>();
  const pendingLogs = new Map<string, LogEntry>();

  function setMetric(metric: ServerMetric): void {
    pendingMetrics.set(metric.serverId, metric);
  }

  function setLog(log: LogEntry): void {
    pendingLogs.set(log.serverId, log);
  }

  function flushMetrics(): ServerMetric[] {
    const values = Array.from(pendingMetrics.values());
    pendingMetrics.clear();
    return values;
  }

  function flushLogs(): LogEntry[] {
    const values = Array.from(pendingLogs.values());
    pendingLogs.clear();
    return values;
  }

  return { setMetric, setLog, flushMetrics, flushLogs };
}

export type DataBuffer = ReturnType<typeof createDataBuffer>;

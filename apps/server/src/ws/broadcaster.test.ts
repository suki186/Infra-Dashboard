import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ServerMetric, LogEntry, WSMessage } from '@infra-dashboard/shared';
import { createDataBuffer } from './dataBuffer';
import { startBroadcaster } from './broadcaster';

function makeFakeClient() {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

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

describe('broadcaster', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts buffered metrics to every connected client on each tick', () => {
    const dataBuffer = createDataBuffer();
    const client = makeFakeClient();
    const connectionManager = { getClients: () => new Set([client]) };

    const broadcaster = startBroadcaster({ connectionManager, dataBuffer, intervalMs: 1000 });

    dataBuffer.setMetric(makeMetric());
    vi.advanceTimersByTime(1000);

    expect(client.send).toHaveBeenCalledTimes(1);
    const sent: WSMessage = JSON.parse(client.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: 'metrics', payload: makeMetric() });

    broadcaster.stop();
  });

  it('broadcasts buffered logs to every connected client on each tick', () => {
    const dataBuffer = createDataBuffer();
    const client = makeFakeClient();
    const connectionManager = { getClients: () => new Set([client]) };

    const broadcaster = startBroadcaster({ connectionManager, dataBuffer, intervalMs: 1000 });

    dataBuffer.setLog(makeLog());
    vi.advanceTimersByTime(1000);

    expect(client.send).toHaveBeenCalledTimes(1);
    const sent: WSMessage = JSON.parse(client.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: 'log', payload: makeLog() });

    broadcaster.stop();
  });

  it('does not resend when no new data arrived since the last tick', () => {
    const dataBuffer = createDataBuffer();
    const client = makeFakeClient();
    const connectionManager = { getClients: () => new Set([client]) };

    const broadcaster = startBroadcaster({ connectionManager, dataBuffer, intervalMs: 1000 });

    dataBuffer.setMetric(makeMetric());
    vi.advanceTimersByTime(1000);
    expect(client.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(client.send).toHaveBeenCalledTimes(1);

    broadcaster.stop();
  });

  it('runs on the configured interval, not the 1000ms default', () => {
    const dataBuffer = createDataBuffer();
    const client = makeFakeClient();
    const connectionManager = { getClients: () => new Set([client]) };

    const broadcaster = startBroadcaster({ connectionManager, dataBuffer, intervalMs: 250 });

    dataBuffer.setMetric(makeMetric({ cpuUsage: 1 }));
    vi.advanceTimersByTime(250);
    expect(client.send).toHaveBeenCalledTimes(1);

    dataBuffer.setMetric(makeMetric({ cpuUsage: 2 }));
    vi.advanceTimersByTime(250);
    expect(client.send).toHaveBeenCalledTimes(2);

    broadcaster.stop();
  });

  it('skips clients that are not open', () => {
    const dataBuffer = createDataBuffer();
    const openClient = makeFakeClient();
    const closedClient = { ...makeFakeClient(), readyState: 3 } as unknown as WebSocket & {
      send: ReturnType<typeof vi.fn>;
    };
    const connectionManager = { getClients: () => new Set([openClient, closedClient]) };

    const broadcaster = startBroadcaster({ connectionManager, dataBuffer, intervalMs: 1000 });

    dataBuffer.setMetric(makeMetric());
    vi.advanceTimersByTime(1000);

    expect(openClient.send).toHaveBeenCalledTimes(1);
    expect((closedClient as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();

    broadcaster.stop();
  });

  it('stops broadcasting once stop() is called', () => {
    const dataBuffer = createDataBuffer();
    const client = makeFakeClient();
    const connectionManager = { getClients: () => new Set([client]) };

    const broadcaster = startBroadcaster({ connectionManager, dataBuffer, intervalMs: 1000 });
    broadcaster.stop();

    dataBuffer.setMetric(makeMetric());
    vi.advanceTimersByTime(5000);

    expect(client.send).not.toHaveBeenCalled();
  });
});

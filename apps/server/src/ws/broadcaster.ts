import type { WebSocket } from 'ws';
import type { WSMessage } from '@infra-dashboard/shared';
import type { DataBuffer } from './dataBuffer';

const DEFAULT_INTERVAL_MS = 1000;
const WEBSOCKET_OPEN = 1;

export interface BroadcasterDeps {
  connectionManager: { getClients(): ReadonlySet<WebSocket> };
  dataBuffer: DataBuffer;
  intervalMs?: number;
}

export function startBroadcaster({ connectionManager, dataBuffer, intervalMs }: BroadcasterDeps) {
  const envIntervalMs = Number(process.env.BROADCAST_INTERVAL_MS);
  const resolvedIntervalMs =
    intervalMs ?? (Number.isFinite(envIntervalMs) && envIntervalMs > 0 ? envIntervalMs : DEFAULT_INTERVAL_MS);

  function broadcast(message: WSMessage): void {
    const payload = JSON.stringify(message);
    for (const client of connectionManager.getClients()) {
      if (client.readyState === WEBSOCKET_OPEN) {
        client.send(payload);
      }
    }
  }

  function tick(): void {
    for (const metric of dataBuffer.flushMetrics()) {
      broadcast({ type: 'metrics', payload: metric });
    }
    for (const log of dataBuffer.flushLogs()) {
      broadcast({ type: 'log', payload: log });
    }
  }

  const timer = setInterval(tick, resolvedIntervalMs);

  function stop(): void {
    clearInterval(timer);
  }

  return { stop };
}

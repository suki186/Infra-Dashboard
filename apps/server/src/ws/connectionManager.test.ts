import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { createConnectionManager, createConnectionHandler } from './connectionManager';

async function buildTestApp(connectionManager: ReturnType<typeof createConnectionManager>) {
  const app: FastifyInstance = Fastify();
  await app.register(websocketPlugin);
  app.get('/ws', { websocket: true }, createConnectionHandler(connectionManager));
  await app.ready();
  return app;
}

describe('connectionManager', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('registers a client when a WebSocket connection is established', async () => {
    const connectionManager = createConnectionManager();
    app = await buildTestApp(connectionManager);

    expect(connectionManager.getClients().size).toBe(0);

    const ws = await app.injectWS('/ws');

    expect(connectionManager.getClients().size).toBe(1);

    ws.terminate();
  });

  it('removes the client and cleans up when the connection closes', async () => {
    const connectionManager = createConnectionManager();
    app = await buildTestApp(connectionManager);

    const ws = await app.injectWS('/ws');
    expect(connectionManager.getClients().size).toBe(1);

    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    ws.terminate();
    await closed;

    await new Promise((resolve) => setImmediate(resolve));

    expect(connectionManager.getClients().size).toBe(0);
  });
});

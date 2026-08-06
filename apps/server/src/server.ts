import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { prisma } from './db/client';
import type { ServerMetric } from '@infra-dashboard/shared';
import { createConnectionManager, createConnectionHandler } from './ws/connectionManager';
import { createDataBuffer } from './ws/dataBuffer';
import { startBroadcaster } from './ws/broadcaster';
import { registerMetricsRoutes } from './routes/metrics';
import { registerLogsRoutes } from './routes/logs';
import { registerHistoryRoutes } from './routes/history';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const DEV_ORIGIN = 'http://localhost:3000';
const ALLOWED_ORIGINS = [
  DEV_ORIGIN,
  ...(process.env.ALLOWED_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []),
];

const app = Fastify({ logger: true });

const connectionManager = createConnectionManager();
const dataBuffer = createDataBuffer();
const broadcaster = startBroadcaster({ connectionManager, dataBuffer });

app.addHook('onClose', async () => {
  broadcaster.stop();
});

app.get('/health', async () => {
  return { status: 'ok' };
});

app.get('/health/db', async (request, reply) => {
  try {
    const count = await prisma.infrastructureMetric.count();
    return { status: 'ok', infrastructureMetricsCount: count };
  } catch (err) {
    request.log.error(err);
    reply.code(500);
    return { status: 'error', message: (err as Error).message };
  }
});

app.get('/health/shared-types', async () => {
  const sample: ServerMetric = {
    serverId: 'kr-seoul-web-01',
    status: 'healthy',
    cpuUsage: 12.3,
    memoryUsage: 45.6,
    diskIo: 1.2,
    createdAt: new Date().toISOString(),
  };
  return sample;
});

async function main(): Promise<void> {
  await app.register(cors, { origin: ALLOWED_ORIGINS });

  // @fastify/websocket must finish registering before routes that use
  // `{ websocket: true }` are declared, otherwise its onRoute hook isn't in
  // place yet and the route silently falls back to a plain HTTP handler.
  await app.register(websocketPlugin);
  app.get('/ws', { websocket: true }, createConnectionHandler(connectionManager));

  await app.register(registerMetricsRoutes({ dataBuffer, prisma }));
  await app.register(registerLogsRoutes({ dataBuffer, prisma }));
  await app.register(registerHistoryRoutes({ prisma }));

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Server listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

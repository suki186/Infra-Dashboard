import Fastify from 'fastify';
import { prisma } from './db/client';
import type { ServerMetric } from '@infra-dashboard/shared';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = Fastify({ logger: true });

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

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`Server listening on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

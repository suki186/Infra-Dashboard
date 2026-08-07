import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';

export interface HealthRouteDeps {
  prisma: {
    infrastructureMetric: Pick<PrismaClient['infrastructureMetric'], 'count'>;
  };
}

export function registerHealthRoutes(deps: HealthRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/health', async () => {
      return { status: 'ok' };
    });

    fastify.get('/health/db', async (request, reply) => {
      try {
        const count = await deps.prisma.infrastructureMetric.count();
        return { status: 'ok', infrastructureMetricsCount: count };
      } catch (err) {
        request.log.error(err);
        reply.code(500);
        return { status: 'error', message: (err as Error).message };
      }
    });
  };
}

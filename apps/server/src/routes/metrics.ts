import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ServerMetric } from '@infra-dashboard/shared';
import type { DataBuffer } from '../ws/dataBuffer';

export interface MetricsRouteDeps {
  dataBuffer: DataBuffer;
  prisma: {
    infrastructureMetric: Pick<PrismaClient['infrastructureMetric'], 'create'>;
  };
}

type MetricInput = Omit<ServerMetric, 'createdAt'>;

function isValidMetricBody(body: unknown): body is MetricInput {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.serverId === 'string' &&
    b.serverId.length > 0 &&
    typeof b.status === 'string' &&
    typeof b.cpuUsage === 'number' &&
    Number.isFinite(b.cpuUsage) &&
    typeof b.memoryUsage === 'number' &&
    Number.isFinite(b.memoryUsage) &&
    typeof b.diskIo === 'number' &&
    Number.isFinite(b.diskIo)
  );
}

export function registerMetricsRoutes(deps: MetricsRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post('/api/metrics', async (request, reply) => {
      if (!isValidMetricBody(request.body)) {
        reply.code(400);
        return { error: 'invalid metric payload' };
      }

      const { serverId, status, cpuUsage, memoryUsage, diskIo } = request.body;
      const metric: ServerMetric = {
        serverId,
        status,
        cpuUsage,
        memoryUsage,
        diskIo,
        createdAt: new Date().toISOString(),
      };

      deps.dataBuffer.setMetric(metric);

      await deps.prisma.infrastructureMetric.create({
        data: {
          serverId: metric.serverId,
          status: metric.status,
          cpuUsage: metric.cpuUsage,
          memoryUsage: metric.memoryUsage,
          diskIo: metric.diskIo,
          createdAt: new Date(metric.createdAt),
        },
      });

      reply.code(201);
      return metric;
    });
  };
}

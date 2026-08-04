import type { FastifyPluginAsync } from 'fastify';
import type { InfrastructureLog, InfrastructureMetric, PrismaClient } from '@prisma/client';

export interface HistoryRouteDeps {
  prisma: {
    infrastructureMetric: Pick<PrismaClient['infrastructureMetric'], 'findMany' | 'count'>;
    infrastructureLog: Pick<PrismaClient['infrastructureLog'], 'findMany' | 'count'>;
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parsePagination(query: Record<string, unknown>): { limit: number; page: number } {
  const rawLimit = Number(query.limit);
  const rawPage = Number(query.page);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  return { limit, page };
}

function parseServerId(query: Record<string, unknown>): string | undefined {
  return typeof query.serverId === 'string' && query.serverId.length > 0 ? query.serverId : undefined;
}

function serializeMetric(row: InfrastructureMetric) {
  return {
    id: row.id.toString(),
    serverId: row.serverId,
    status: row.status,
    cpuUsage: row.cpuUsage,
    memoryUsage: row.memoryUsage,
    diskIo: row.diskIo,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeLog(row: InfrastructureLog) {
  return {
    id: row.id.toString(),
    serverId: row.serverId,
    level: row.level,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

export function registerHistoryRoutes(deps: HistoryRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/api/metrics/history', async (request) => {
      const query = request.query as Record<string, unknown>;
      const { limit, page } = parsePagination(query);
      const serverId = parseServerId(query);
      const where = serverId ? { serverId } : {};

      const [rows, total] = await Promise.all([
        deps.prisma.infrastructureMetric.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: (page - 1) * limit,
        }),
        deps.prisma.infrastructureMetric.count({ where }),
      ]);

      return { data: rows.map(serializeMetric), page, limit, total };
    });

    fastify.get('/api/logs/history', async (request) => {
      const query = request.query as Record<string, unknown>;
      const { limit, page } = parsePagination(query);
      const serverId = parseServerId(query);
      const where = serverId ? { serverId } : {};

      const [rows, total] = await Promise.all([
        deps.prisma.infrastructureLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: (page - 1) * limit,
        }),
        deps.prisma.infrastructureLog.count({ where }),
      ]);

      return { data: rows.map(serializeLog), page, limit, total };
    });
  };
}

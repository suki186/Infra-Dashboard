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
          // id를 tie-break로 추가: 같은 tick에 기록된 여러 서버의 row는 createdAt이
          // 완전히 동일하므로, id 정렬이 없으면 페이지 경계에서 순서가 흔들려
          // 프론트가 timestamp 기준으로 그룹핑할 때 같은 tick의 row가 서로 다른
          // 페이지로 쪼개질 수 있다.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

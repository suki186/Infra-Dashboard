import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerHistoryRoutes } from './history';

function buildApp() {
  const prisma = {
    infrastructureMetric: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    infrastructureLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  const app = Fastify();
  app.register(registerHistoryRoutes({ prisma }));
  return { app, prisma };
}

describe('GET /api/metrics/history', () => {
  it('returns paginated metrics ordered newest first', async () => {
    const { app, prisma } = buildApp();
    const rows = [
      {
        id: 2n,
        serverId: 'kr-seoul-web-01',
        status: 'healthy',
        cpuUsage: 12,
        memoryUsage: 30,
        diskIo: 1,
        createdAt: new Date('2026-08-04T00:00:01.000Z'),
      },
    ];
    prisma.infrastructureMetric.findMany.mockResolvedValue(rows);
    prisma.infrastructureMetric.count.mockResolvedValue(1);

    const response = await app.inject({ method: 'GET', url: '/api/metrics/history?limit=20&page=1' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      data: [
        {
          id: '2',
          serverId: 'kr-seoul-web-01',
          status: 'healthy',
          cpuUsage: 12,
          memoryUsage: 30,
          diskIo: 1,
          createdAt: '2026-08-04T00:00:01.000Z',
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
    });

    expect(prisma.infrastructureMetric.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 20,
      skip: 0,
    });
  });

  it('filters by serverId when provided', async () => {
    const { app, prisma } = buildApp();
    prisma.infrastructureMetric.findMany.mockResolvedValue([]);
    prisma.infrastructureMetric.count.mockResolvedValue(0);

    await app.inject({ method: 'GET', url: '/api/metrics/history?serverId=kr-seoul-web-01' });

    expect(prisma.infrastructureMetric.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serverId: 'kr-seoul-web-01' } }),
    );
  });

  it('applies default limit/page and caps an excessive limit', async () => {
    const { app, prisma } = buildApp();
    prisma.infrastructureMetric.findMany.mockResolvedValue([]);
    prisma.infrastructureMetric.count.mockResolvedValue(0);

    await app.inject({ method: 'GET', url: '/api/metrics/history?limit=999999' });

    const call = prisma.infrastructureMetric.findMany.mock.calls[0][0];
    expect(call.take).toBeLessThanOrEqual(500);
    expect(call.skip).toBe(0);
  });
});

describe('GET /api/logs/history', () => {
  it('returns paginated logs ordered newest first', async () => {
    const { app, prisma } = buildApp();
    const rows = [
      {
        id: 5n,
        serverId: 'kr-seoul-web-01',
        level: 'WARN',
        message: 'disk usage above threshold',
        createdAt: new Date('2026-08-04T00:00:02.000Z'),
      },
    ];
    prisma.infrastructureLog.findMany.mockResolvedValue(rows);
    prisma.infrastructureLog.count.mockResolvedValue(1);

    const response = await app.inject({ method: 'GET', url: '/api/logs/history?limit=10&page=2' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({
      data: [
        {
          id: '5',
          serverId: 'kr-seoul-web-01',
          level: 'WARN',
          message: 'disk usage above threshold',
          createdAt: '2026-08-04T00:00:02.000Z',
        },
      ],
      page: 2,
      limit: 10,
      total: 1,
    });

    expect(prisma.infrastructureLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 10,
      skip: 10,
    });
  });
});

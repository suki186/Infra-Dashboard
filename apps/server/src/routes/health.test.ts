import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerHealthRoutes } from './health';

function buildApp() {
  const prisma = {
    infrastructureMetric: {
      count: vi.fn(),
    },
  };
  const app = Fastify();
  app.register(registerHealthRoutes({ prisma }));
  return { app, prisma };
}

describe('GET /health', () => {
  it('returns a 200 ok status without touching the database', async () => {
    const { app, prisma } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
    expect(prisma.infrastructureMetric.count).not.toHaveBeenCalled();
  });
});

describe('GET /health/db', () => {
  it('returns ok status with the metrics row count when the database is reachable', async () => {
    const { app, prisma } = buildApp();
    prisma.infrastructureMetric.count.mockResolvedValue(42);

    const response = await app.inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', infrastructureMetricsCount: 42 });
  });

  it('returns a 500 error status with the failure message when the database query fails', async () => {
    const { app, prisma } = buildApp();
    prisma.infrastructureMetric.count.mockRejectedValue(new Error('connection refused'));

    const response = await app.inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ status: 'error', message: 'connection refused' });
  });
});

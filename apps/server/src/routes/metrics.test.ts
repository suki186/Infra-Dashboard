import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createDataBuffer } from '../ws/dataBuffer';
import { registerMetricsRoutes } from './metrics';

function buildApp() {
  const dataBuffer = createDataBuffer();
  const prisma = {
    infrastructureMetric: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const app = Fastify();
  app.register(registerMetricsRoutes({ dataBuffer, prisma }));
  return { app, dataBuffer, prisma };
}

const validPayload = {
  serverId: 'kr-seoul-web-01',
  status: 'healthy',
  cpuUsage: 12.3,
  memoryUsage: 45.6,
  diskIo: 1.2,
};

describe('POST /api/metrics', () => {
  it('accepts a valid metric, buffers it, and persists it via Prisma', async () => {
    const { app, dataBuffer, prisma } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/metrics',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject(validPayload);
    expect(typeof body.createdAt).toBe('string');

    expect(prisma.infrastructureMetric.create).toHaveBeenCalledTimes(1);
    expect(prisma.infrastructureMetric.create).toHaveBeenCalledWith({
      data: expect.objectContaining(validPayload),
    });

    const buffered = dataBuffer.flushMetrics();
    expect(buffered).toHaveLength(1);
    expect(buffered[0]).toMatchObject(validPayload);
  });

  it('rejects a payload missing required fields with 400', async () => {
    const { app, prisma } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/metrics',
      payload: { serverId: 'kr-seoul-web-01' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.infrastructureMetric.create).not.toHaveBeenCalled();
  });

  it('rejects a payload with wrong field types with 400', async () => {
    const { app, prisma } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/metrics',
      payload: { ...validPayload, cpuUsage: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.infrastructureMetric.create).not.toHaveBeenCalled();
  });
});

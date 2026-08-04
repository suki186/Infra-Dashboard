import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createDataBuffer } from '../ws/dataBuffer';
import { registerLogsRoutes } from './logs';

function buildApp() {
  const dataBuffer = createDataBuffer();
  const prisma = {
    infrastructureLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const app = Fastify();
  app.register(registerLogsRoutes({ dataBuffer, prisma }));
  return { app, dataBuffer, prisma };
}

const validPayload = {
  serverId: 'kr-seoul-web-01',
  level: 'WARN',
  message: 'disk usage above threshold',
};

describe('POST /api/logs', () => {
  it('accepts a valid log entry, buffers it, and persists it via Prisma', async () => {
    const { app, dataBuffer, prisma } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/logs',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject(validPayload);
    expect(typeof body.createdAt).toBe('string');

    expect(prisma.infrastructureLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.infrastructureLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining(validPayload),
    });

    const buffered = dataBuffer.flushLogs();
    expect(buffered).toHaveLength(1);
    expect(buffered[0]).toMatchObject(validPayload);
  });

  it('rejects a payload missing required fields with 400', async () => {
    const { app, prisma } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/logs',
      payload: { serverId: 'kr-seoul-web-01' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.infrastructureLog.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid log level with 400', async () => {
    const { app, prisma } = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/logs',
      payload: { ...validPayload, level: 'CRITICAL' },
    });

    expect(response.statusCode).toBe(400);
    expect(prisma.infrastructureLog.create).not.toHaveBeenCalled();
  });
});

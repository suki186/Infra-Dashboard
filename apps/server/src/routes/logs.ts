import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { LogEntry, LogLevel } from '@infra-dashboard/shared';
import type { DataBuffer } from '../ws/dataBuffer';

export interface LogsRouteDeps {
  dataBuffer: DataBuffer;
  prisma: {
    infrastructureLog: Pick<PrismaClient['infrastructureLog'], 'create'>;
  };
}

type LogInput = Omit<LogEntry, 'createdAt'>;

const VALID_LOG_LEVELS: readonly LogLevel[] = ['INFO', 'WARN', 'ERROR'];

function isValidLogBody(body: unknown): body is LogInput {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.serverId === 'string' &&
    b.serverId.length > 0 &&
    typeof b.level === 'string' &&
    VALID_LOG_LEVELS.includes(b.level as LogLevel) &&
    typeof b.message === 'string' &&
    b.message.length > 0
  );
}

export function registerLogsRoutes(deps: LogsRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post('/api/logs', async (request, reply) => {
      if (!isValidLogBody(request.body)) {
        reply.code(400);
        return { error: 'invalid log payload' };
      }

      const { serverId, level, message } = request.body;
      const log: LogEntry = {
        serverId,
        level,
        message,
        createdAt: new Date().toISOString(),
      };

      deps.dataBuffer.setLog(log);

      await deps.prisma.infrastructureLog.create({
        data: {
          serverId: log.serverId,
          level: log.level,
          message: log.message,
          createdAt: new Date(log.createdAt),
        },
      });

      reply.code(201);
      return log;
    });
  };
}

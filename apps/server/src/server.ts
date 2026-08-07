import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { prisma } from './db/client';
import type { ServerMetric } from '@infra-dashboard/shared';
import { createConnectionManager, createConnectionHandler } from './ws/connectionManager';
import { createDataBuffer } from './ws/dataBuffer';
import { startBroadcaster } from './ws/broadcaster';
import { registerMetricsRoutes } from './routes/metrics';
import { registerLogsRoutes } from './routes/logs';
import { registerHistoryRoutes } from './routes/history';
import { registerHealthRoutes } from './routes/health';
import { createDemoSimulator } from './demo/simulator';
import { createRetentionScheduler } from './demo/retention';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// 배포 환경(Render)에는 apps/web/scripts/simulator.mjs를 실행할 곳이 없으므로,
// DEMO_MODE=true면 서버가 자체적으로 데모 데이터를 계속 생성한다.
const DEMO_MODE = process.env.DEMO_MODE === 'true';

const DEV_ORIGIN = 'http://localhost:3000';
const ALLOWED_ORIGINS = [
  DEV_ORIGIN,
  ...(process.env.ALLOWED_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []),
];

const app = Fastify({ logger: true });

const connectionManager = createConnectionManager();
const dataBuffer = createDataBuffer();
const broadcaster = startBroadcaster({ connectionManager, dataBuffer });

// dataBuffer에 쓰기만 하면 broadcaster가 자신의 1초 주기 tick에서 알아서
// flush/broadcast하므로, 데모 생성기는 broadcaster와 별도 주기로 돌아도 자연스럽게 맞물린다.
const demoSimulator = DEMO_MODE
  ? createDemoSimulator({
      dataBuffer,
      prisma,
      onError: (err) => app.log.error(err, '[demo] failed to persist generated data'),
    })
  : undefined;

// DEMO_MODE는 데이터를 계속 쌓기만 하므로, 같은 조건에서 오래된 row를 주기적으로
// 정리해 DB 용량이 무한정 늘어나지 않게 한다 (기본: 24시간 초과분을 10분마다 삭제).
const retentionScheduler = DEMO_MODE
  ? createRetentionScheduler({
      prisma,
      onError: (err) => app.log.error(err, '[retention] failed to prune old data'),
    })
  : undefined;

app.addHook('onClose', async () => {
  broadcaster.stop();
  demoSimulator?.stop();
  retentionScheduler?.stop();
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

async function main(): Promise<void> {
  await app.register(cors, { origin: ALLOWED_ORIGINS });

  // @fastify/websocket must finish registering before routes that use
  // `{ websocket: true }` are declared, otherwise its onRoute hook isn't in
  // place yet and the route silently falls back to a plain HTTP handler.
  await app.register(websocketPlugin);
  app.get('/ws', { websocket: true }, createConnectionHandler(connectionManager));

  await app.register(registerMetricsRoutes({ dataBuffer, prisma }));
  await app.register(registerLogsRoutes({ dataBuffer, prisma }));
  await app.register(registerHistoryRoutes({ prisma }));
  await app.register(registerHealthRoutes({ prisma }));

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Server listening on http://${HOST}:${PORT}`);

  if (demoSimulator) {
    demoSimulator.start();
    app.log.info('[demo] DEMO_MODE=true — 내장 데모 데이터 생성기 시작');
  }

  if (retentionScheduler) {
    retentionScheduler.start();
    app.log.info('[retention] DEMO_MODE=true — 데이터 정리 스케줄러 시작');
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

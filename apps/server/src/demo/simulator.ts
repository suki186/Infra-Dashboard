// ─── 내장 데모 데이터 생성기 ──────────────────────────────────────────────────
// apps/web/scripts/simulator.mjs의 로직(삼각함수 기반 메트릭 + 장애 주입 스케줄
// + 로그 생성)을 서버 내부로 이식한 버전이다.
//
// simulator.mjs는 HTTP POST로 apps/server를 호출하기 때문에 로컬에서 두 프로세스를
// 함께 띄워야만 데이터가 흐른다. 배포 환경(Render)에서는 그 스크립트를 실행할 곳이
// 없으므로, DEMO_MODE=true일 때 서버가 이 모듈을 setInterval로 직접 돌려
// dataBuffer/Prisma에 데이터를 써 넣는다 — 네트워크 왕복 없이 함수 호출로 끝난다.
// simulator.mjs는 로컬 개발/디버깅용으로 그대로 남아 있다 (apps/server/.env.example 참고).
import type { PrismaClient } from '@prisma/client';
import type { LogEntry, ServerMetric } from '@infra-dashboard/shared';
import type { DataBuffer } from '../ws/dataBuffer';

export interface DemoSimulatorDeps {
  dataBuffer: DataBuffer;
  prisma: {
    infrastructureMetric: Pick<PrismaClient['infrastructureMetric'], 'create'>;
    infrastructureLog: Pick<PrismaClient['infrastructureLog'], 'create'>;
  };
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

interface DemoServer {
  id: string;
  cpuBase: number;
  memBase: number;
  diskBase: number;
  phase: number;
}

// simulator.mjs의 SERVERS와 동일한 3대 구성.
const SERVERS: readonly DemoServer[] = [
  { id: 'kr-seoul-web-01', cpuBase: 45, memBase: 55, diskBase: 35, phase: 0 },
  { id: 'kr-seoul-db-01', cpuBase: 62, memBase: 73, diskBase: 58, phase: Math.PI / 3 },
  { id: 'kr-jeju-ai-01', cpuBase: 76, memBase: 68, diskBase: 28, phase: (Math.PI * 2) / 3 },
];

const STRESSED_SERVER_ID = 'kr-seoul-web-01';
const OFFLINE_SERVER_ID = 'kr-jeju-ai-01';

// simulator.mjs는 20s/40s/60s에 setTimeout 한 번씩만 장애를 주입하고 끝난다.
// 배포 환경에서는 서버가 계속 떠 있으므로, 같은 타임라인(정상 20s → STRESS 20s →
// STRESS+OFFLINE 20s → RECOVERY 30s)을 90초 주기로 반복시켜 언제 접속해도
// 장애 시나리오를 관찰할 수 있게 한다.
const CYCLE_MS = 90_000;
const STRESS_START_MS = 20_000;
const OFFLINE_START_MS = 40_000;
const RECOVERY_START_MS = 60_000;

function clamp(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const INFO_POOL: ReadonlyArray<() => string> = [
  () => `Connection pool active (${rand(15, 60)}/100)`,
  () => `Health check passed — latency ${rand(3, 30)}ms`,
  () => `Cache hit rate ${(85 + Math.random() * 12).toFixed(1)}%`,
  () => `Request queue depth: ${rand(0, 22)}`,
  () => `Worker thread pool: ${rand(6, 8)}/8 active`,
  () => `Memory GC cycle completed — freed ${rand(32, 256)}MB`,
  () => `Auth token refresh OK`,
  () => `SSL cert valid — expires in ${rand(30, 365)} days`,
  () => `Replica sync lag: ${rand(2, 50)}ms`,
  () => `Scheduled flush — ${rand(80, 400)} records committed`,
  () => `Load balancer heartbeat OK — ${rand(2, 6)} backends healthy`,
  () => `Disk SMART check passed`,
];

const WARN_POOL: ReadonlyArray<(cpu: number) => string> = [
  (cpu) => `High CPU load — threshold breached: ${cpu.toFixed(1)}%`,
  () => `Connection pool at ${rand(72, 88)}% capacity`,
  () => `Disk write latency elevated — p99: ${rand(150, 400)}ms`,
  () => `Response time degradation — p95: ${(0.8 + Math.random()).toFixed(1)}s`,
  () => `TCP retransmit rate elevated: ${(1 + Math.random() * 4).toFixed(1)}%`,
  () => `Swap usage increasing — ${rand(25, 50)}% utilized`,
  () => `Open file descriptors: ${rand(800, 950)}/1024`,
];

const ERROR_POOL: ReadonlyArray<(cpu: number) => string> = [
  () => `FATAL: Connection pool exhausted (max 100)`,
  () => `Database connection timeout after 30s — retrying`,
  () => `Health check FAILED — service unresponsive`,
  (cpu) => `ALERT: CPU thermal throttling active (${cpu.toFixed(1)}%)`,
  () => `CRITICAL: disk I/O saturation — writes queued`,
  () => `OOM killer invoked — PID ${rand(1000, 9999)} terminated`,
  () => `Kernel: CPU scheduler overload — tasks delayed`,
  () => `Socket backlog overflow — connections dropped`,
];

function incidentState(nowMs: number): { isStressed: boolean; isOffline: boolean } {
  const t = nowMs % CYCLE_MS;
  const isStressed = t >= STRESS_START_MS && t < RECOVERY_START_MS;
  const isOffline = t >= OFFLINE_START_MS && t < RECOVERY_START_MS;
  return { isStressed, isOffline };
}

function generateMetric(server: DemoServer, nowMs: number, isStressed: boolean, isOffline: boolean): ServerMetric {
  const createdAt = new Date(nowMs).toISOString();

  if (isOffline) {
    return {
      serverId: server.id,
      status: 'OFFLINE',
      cpuUsage: 0,
      memoryUsage: 0,
      diskIo: 0,
      createdAt,
    };
  }

  const t = nowMs / 1000;
  const TWO_PI = 2 * Math.PI;
  const LONG_FREQ = TWO_PI / 300;
  const SHORT_FREQ = TWO_PI / 60;
  const MEM_FREQ = TWO_PI / 420;
  const DISK_FREQ = TWO_PI / 120;

  let cpu: number;
  let memory: number;
  let diskIo: number;

  if (isStressed) {
    cpu = clamp(95 + Math.random() * 4);
    diskIo = clamp(60 + 35 * Math.abs(Math.sin((t * TWO_PI) / 3)) + Math.random() * 5);
    memory = clamp(server.memBase + 15 + 8 * Math.cos(t * MEM_FREQ + server.phase) + Math.random() * 5);
  } else {
    cpu = clamp(
      server.cpuBase +
        18 * Math.sin(t * LONG_FREQ + server.phase) +
        6 * Math.cos(t * SHORT_FREQ + server.phase) +
        Math.random() * 5,
    );
    memory = clamp(
      server.memBase +
        12 * Math.cos(t * MEM_FREQ + server.phase + Math.PI / 4) +
        3 * Math.sin(t * SHORT_FREQ + server.phase) +
        Math.random() * 5,
    );
    diskIo = clamp(
      server.diskBase +
        22 * Math.sin(t * DISK_FREQ + server.phase + Math.PI / 2) +
        5 * Math.cos(t * SHORT_FREQ + server.phase) +
        Math.random() * 5,
    );
  }

  return {
    serverId: server.id,
    status: 'ONLINE',
    cpuUsage: parseFloat(cpu.toFixed(1)),
    memoryUsage: parseFloat(memory.toFixed(1)),
    diskIo: parseFloat(diskIo.toFixed(1)),
    createdAt,
  };
}

function generateLogs(serverId: string, isOffline: boolean, metric: ServerMetric): LogEntry[] {
  const cpu = metric.cpuUsage;
  const logs: LogEntry[] = [];

  if (isOffline) {
    if (Math.random() < 0.25) {
      logs.push({
        serverId,
        level: 'WARN',
        message: 'Server is OFFLINE — all metrics reporting zero',
        createdAt: metric.createdAt,
      });
    }
    return logs;
  }

  if (Math.random() < 0.65) {
    logs.push({ serverId, level: 'INFO', message: pick(INFO_POOL)(), createdAt: metric.createdAt });
  }

  if (cpu >= 70) {
    logs.push({ serverId, level: 'WARN', message: pick(WARN_POOL)(cpu), createdAt: metric.createdAt });
  }

  if (cpu >= 90) {
    logs.push({ serverId, level: 'ERROR', message: pick(ERROR_POOL)(cpu), createdAt: metric.createdAt });
    if (Math.random() < 0.55) {
      logs.push({ serverId, level: 'ERROR', message: pick(ERROR_POOL)(cpu), createdAt: metric.createdAt });
    }
  }

  return logs;
}

export function createDemoSimulator(deps: DemoSimulatorDeps) {
  const envIntervalMs = Number(process.env.DEMO_INTERVAL_MS);
  const intervalMs =
    deps.intervalMs ?? (Number.isFinite(envIntervalMs) && envIntervalMs > 0 ? envIntervalMs : 1000);

  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    const now = Date.now();
    const { isStressed, isOffline } = incidentState(now);

    const metrics: ServerMetric[] = [];
    const logs: LogEntry[] = [];

    for (const server of SERVERS) {
      const stressed = server.id === STRESSED_SERVER_ID && isStressed;
      const offline = server.id === OFFLINE_SERVER_ID && isOffline;

      const metric = generateMetric(server, now, stressed, offline);
      metrics.push(metric);
      deps.dataBuffer.setMetric(metric);

      for (const log of generateLogs(server.id, offline, metric)) {
        logs.push(log);
        deps.dataBuffer.setLog(log);
      }
    }

    const results = await Promise.allSettled([
      ...metrics.map((metric) =>
        deps.prisma.infrastructureMetric.create({
          data: {
            serverId: metric.serverId,
            status: metric.status,
            cpuUsage: metric.cpuUsage,
            memoryUsage: metric.memoryUsage,
            diskIo: metric.diskIo,
            createdAt: new Date(metric.createdAt),
          },
        }),
      ),
      ...logs.map((log) =>
        deps.prisma.infrastructureLog.create({
          data: {
            serverId: log.serverId,
            level: log.level,
            message: log.message,
            createdAt: new Date(log.createdAt),
          },
        }),
      ),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        deps.onError?.(result.reason);
      }
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((err) => deps.onError?.(err));
    }, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { start, stop };
}

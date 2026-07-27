// ─── PulseOps 시뮬레이터 ──────────────────────────────────────────────────────
// 사용 전 Supabase SQL Editor에서 아래 마이그레이션을 1회 실행하세요:
//
//   CREATE TABLE IF NOT EXISTS infrastructure_logs (
//     id         bigserial    PRIMARY KEY,
//     created_at timestamptz  NOT NULL DEFAULT now(),
//     server_id  text         NOT NULL,
//     level      text         NOT NULL,
//     message    text         NOT NULL
//   );
//   ALTER TABLE infrastructure_logs REPLICA IDENTITY FULL;
//   ALTER PUBLICATION supabase_realtime ADD TABLE infrastructure_logs;

import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env.local' })

// ─── Supabase 클라이언트 초기화 ───────────────────────────────────────────────
const { NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_KEY } = process.env

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ .env.local 에서 Supabase 환경 변수를 읽지 못했습니다.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── 가상 서버 정의 ───────────────────────────────────────────────────────────
const SERVERS = [
  {
    id:         'kr-seoul-web-01',
    status:     'ONLINE',
    cpu_base:   45,
    mem_base:   55,
    disk_base:  35,
    phase:      0,
    isStressed: false,
    isOffline:  false,
  },
  {
    id:         'kr-seoul-db-01',
    status:     'ONLINE',
    cpu_base:   62,
    mem_base:   73,
    disk_base:  58,
    phase:      Math.PI / 3,
    isStressed: false,
    isOffline:  false,
  },
  {
    id:         'kr-jeju-ai-01',
    status:     'ONLINE',
    cpu_base:   76,
    mem_base:   68,
    disk_base:  28,
    phase:      (Math.PI * 2) / 3,
    isStressed: false,
    isOffline:  false,
  },
]

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────
function clamp(v) { return Math.min(100, Math.max(0, v)) }

function rand(min, max) { return Math.floor(min + Math.random() * (max - min + 1)) }

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

// ─── 로그 메시지 풀 ───────────────────────────────────────────────────────────
const INFO_POOL = [
  ()        => `Connection pool active (${rand(15, 60)}/100)`,
  ()        => `Health check passed — latency ${rand(3, 30)}ms`,
  ()        => `Cache hit rate ${(85 + Math.random() * 12).toFixed(1)}%`,
  ()        => `Request queue depth: ${rand(0, 22)}`,
  ()        => `Worker thread pool: ${rand(6, 8)}/8 active`,
  ()        => `Memory GC cycle completed — freed ${rand(32, 256)}MB`,
  ()        => `Auth token refresh OK`,
  ()        => `SSL cert valid — expires in ${rand(30, 365)} days`,
  ()        => `Replica sync lag: ${rand(2, 50)}ms`,
  ()        => `Scheduled flush — ${rand(80, 400)} records committed`,
  ()        => `Load balancer heartbeat OK — ${rand(2, 6)} backends healthy`,
  ()        => `Disk SMART check passed`,
]

const WARN_POOL = [
  (cpu)     => `High CPU load — threshold breached: ${cpu.toFixed(1)}%`,
  ()        => `Connection pool at ${rand(72, 88)}% capacity`,
  ()        => `Disk write latency elevated — p99: ${rand(150, 400)}ms`,
  ()        => `Response time degradation — p95: ${(0.8 + Math.random()).toFixed(1)}s`,
  ()        => `TCP retransmit rate elevated: ${(1 + Math.random() * 4).toFixed(1)}%`,
  ()        => `Swap usage increasing — ${rand(25, 50)}% utilized`,
  ()        => `Open file descriptors: ${rand(800, 950)}/1024`,
]

const ERROR_POOL = [
  ()        => `FATAL: Connection pool exhausted (max 100)`,
  ()        => `Database connection timeout after 30s — retrying`,
  ()        => `Health check FAILED — service unresponsive`,
  (cpu)     => `ALERT: CPU thermal throttling active (${cpu.toFixed(1)}%)`,
  ()        => `CRITICAL: disk I/O saturation — writes queued`,
  ()        => `OOM killer invoked — PID ${rand(1000, 9999)} terminated`,
  ()        => `Kernel: CPU scheduler overload — tasks delayed`,
  ()        => `Socket backlog overflow — connections dropped`,
]

// ─── 로그 생성기 ──────────────────────────────────────────────────────────────
function generateLogs(server, computedMetrics) {
  const { id: server_id, isOffline, isStressed } = server
  const cpu = computedMetrics.cpu_usage
  const logs = []

  if (isOffline) {
    // 오프라인 서버: 낮은 확률로 경고성 INFO
    if (Math.random() < 0.25) {
      logs.push({ server_id, level: 'WARN', message: 'Server is OFFLINE — all metrics reporting zero' })
    }
    return logs
  }

  // INFO: 65% 확률로 1줄
  if (Math.random() < 0.65) {
    logs.push({ server_id, level: 'INFO', message: pick(INFO_POOL)() })
  }

  // WARN: CPU 70% 이상 구간에서 항상 발생
  if (cpu >= 70) {
    logs.push({ server_id, level: 'WARN', message: pick(WARN_POOL)(cpu) })
  }

  // ERROR: CPU 90% 이상 (스트레스) 구간에서 1~2줄 항상 발생
  if (cpu >= 90) {
    logs.push({ server_id, level: 'ERROR', message: pick(ERROR_POOL)(cpu) })
    if (Math.random() < 0.55) {
      logs.push({ server_id, level: 'ERROR', message: pick(ERROR_POOL)(cpu) })
    }
  }

  return logs
}

// ─── 삼각함수 기반 메트릭 생성 ────────────────────────────────────────────────
function generateMetrics(server, nowMs) {
  if (server.isOffline) {
    return {
      server_id:     server.id,
      status:        'OFFLINE',
      cpu_usage:     0,
      memory_usage:  0,
      disk_io:       0,
      recorded_at:   new Date(nowMs).toISOString(),
    }
  }

  const t = nowMs / 1000
  const TWO_PI     = 2 * Math.PI
  const LONG_FREQ  = TWO_PI / 300
  const SHORT_FREQ = TWO_PI / 60
  const MEM_FREQ   = TWO_PI / 420
  const DISK_FREQ  = TWO_PI / 120

  let cpu, memory, disk_io

  if (server.isStressed) {
    cpu     = clamp(95 + Math.random() * 4)
    disk_io = clamp(60 + 35 * Math.abs(Math.sin(t * TWO_PI / 3)) + Math.random() * 5)
    memory  = clamp(server.mem_base + 15 + 8 * Math.cos(t * MEM_FREQ + server.phase) + Math.random() * 5)
  } else {
    cpu     = clamp(server.cpu_base + 18 * Math.sin(t * LONG_FREQ + server.phase) + 6 * Math.cos(t * SHORT_FREQ + server.phase) + Math.random() * 5)
    memory  = clamp(server.mem_base + 12 * Math.cos(t * MEM_FREQ + server.phase + Math.PI / 4) + 3 * Math.sin(t * SHORT_FREQ + server.phase) + Math.random() * 5)
    disk_io = clamp(server.disk_base + 22 * Math.sin(t * DISK_FREQ + server.phase + Math.PI / 2) + 5 * Math.cos(t * SHORT_FREQ + server.phase) + Math.random() * 5)
  }

  return {
    server_id:    server.id,
    status:       server.status,
    cpu_usage:    parseFloat(cpu.toFixed(1)),
    memory_usage: parseFloat(memory.toFixed(1)),
    disk_io:      parseFloat(disk_io.toFixed(1)),
    recorded_at:  new Date(nowMs).toISOString(),
  }
}

// ─── ANSI 컬러 헬퍼 ───────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  bgRed: '\x1b[41m', bgYellow: '\x1b[43m',
  cyan: '\x1b[36m', white: '\x1b[97m', black: '\x1b[30m',
}

function printAlert(level, message) {
  const B = '═'.repeat(72)
  if (level === 'stress') {
    console.log(`\n${C.bold}${C.bgYellow}${C.black} ⚠️  STRESS INJECTED ${C.reset}`)
    console.log(`${C.bold}${C.yellow}╔${B}╗${C.reset}`)
    console.log(`${C.bold}${C.yellow}║  ${message.padEnd(71)}║${C.reset}`)
    console.log(`${C.bold}${C.yellow}╚${B}╝${C.reset}\n`)
  } else if (level === 'down') {
    console.log(`\n${C.bold}${C.bgRed}${C.white} 🚨 SERVER DOWN ${C.reset}`)
    console.log(`${C.bold}${C.red}╔${B}╗${C.reset}`)
    console.log(`${C.bold}${C.red}║  ${message.padEnd(71)}║${C.reset}`)
    console.log(`${C.bold}${C.red}╚${B}╝${C.reset}\n`)
  } else if (level === 'recovery') {
    console.log(`\n${C.bold}${C.bgYellow}${C.black} ✅ SYSTEM RECOVERY ${C.reset}`)
    console.log(`${C.bold}${C.green}╔${B}╗${C.reset}`)
    console.log(`${C.bold}${C.green}║  ${message.padEnd(71)}║${C.reset}`)
    console.log(`${C.bold}${C.green}╚${B}╝${C.reset}\n`)
  }
}

// ─── 장애 주입 스케줄 ─────────────────────────────────────────────────────────
const web01  = SERVERS.find(s => s.id === 'kr-seoul-web-01')
const jeju01 = SERVERS.find(s => s.id === 'kr-jeju-ai-01')

setTimeout(() => {
  web01.isStressed = true
  printAlert('stress', '⚠️  [STRESS INJECTED]  kr-seoul-web-01  CPU 폭주 시작! (isStressed → true)')
}, 20_000)

setTimeout(() => {
  jeju01.isOffline = true
  jeju01.status    = 'OFFLINE'
  printAlert('down', '🚨 [SERVER DOWN]  kr-jeju-ai-01  OFFLINE 상태 돌입!')
}, 40_000)

setTimeout(() => {
  web01.isStressed = false
  jeju01.isOffline = false
  jeju01.status    = 'ONLINE'
  printAlert('recovery', '✅ [RECOVERY]  전체 장애 해제 — 정상 복구 완료')
}, 60_000)

// ─── 기동 메시지 ──────────────────────────────────────────────────────────────
console.log(`\n${C.bold}${C.cyan}🚀 PulseOps 시뮬레이터 시작${C.reset}  ${C.dim}(Ctrl+C 로 종료)${C.reset}`)
console.log(`${C.dim}  전송 주기 : 1000ms · 서버 ${SERVERS.length}대 · 메트릭 ${SERVERS.length}rows/회 + 로그 N rows/회`)
console.log(`  T+20s   kr-seoul-web-01  STRESS 주입 (CPU 95-99% + ERROR 로그)`)
console.log(`  T+40s   kr-jeju-ai-01   OFFLINE 전환`)
console.log(`  T+60s   전체 RECOVERY${C.reset}\n`)

let txCount = 0

// ─── 메인 루프 (1초) ──────────────────────────────────────────────────────────
setInterval(async () => {
  const now         = Date.now()
  const allMetrics  = SERVERS.map(s => generateMetrics(s, now))
  const metricRows  = allMetrics.map(({ server_id, status, cpu_usage, memory_usage, disk_io }) => ({
    server_id, status, cpu_usage, memory_usage, disk_io,
  }))

  // 각 서버의 실제 CPU 값을 기반으로 로그 생성
  const logRows = []
  for (let i = 0; i < SERVERS.length; i++) {
    const entries = generateLogs(SERVERS[i], allMetrics[i])
    logRows.push(...entries)
  }

  txCount++
  process.stdout.write(
    `\r${C.bold}${C.cyan}🚀 [SIMULATOR]${C.reset}` +
    `  tx: ${C.white}${String(txCount).padStart(6)}${C.reset}` +
    `  metrics: ${C.green}${metricRows.length}${C.reset}` +
    `  logs: ${C.yellow}${String(logRows.length).padStart(2)}${C.reset}`
  )

  // 메트릭 INSERT
  const { error: metricsErr } = await supabase
    .from('infrastructure_metrics')
    .insert(metricRows)

  if (metricsErr) {
    process.stdout.write('\n')
    console.log(`${C.bold}${C.red}❌ [METRICS ERROR]${C.reset}  ${C.red}${metricsErr.message}${C.reset}`)
  }

  // 로그 INSERT (로그 없는 틱도 있으므로 빈 배열 체크)
  if (logRows.length > 0) {
    const { error: logsErr } = await supabase
      .from('infrastructure_logs')
      .insert(logRows)

    if (logsErr) {
      process.stdout.write('\n')
      console.log(`${C.bold}${C.yellow}⚠️  [LOG ERROR]${C.reset}  ${C.yellow}${logsErr.message}${C.reset}`)
    }
  }
}, 1_000)

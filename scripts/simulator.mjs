import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

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
    phase:      Math.PI / 3,        // 60° 위상차
    isStressed: false,
    isOffline:  false,
  },
  {
    id:         'kr-jeju-ai-01',
    status:     'ONLINE',
    cpu_base:   76,
    mem_base:   68,
    disk_base:  28,
    phase:      (Math.PI * 2) / 3,  // 120° 위상차
    isStressed: false,
    isOffline:  false,
  },
]

// ─── 수치를 0–100% 범위로 클램핑 ──────────────────────────────────────────────
function clamp(v) {
  return Math.min(100, Math.max(0, v))
}

// ─── 삼각함수 기반 메트릭 생성 ────────────────────────────────────────────────
function generateMetrics(server, nowMs) {
  // OFFLINE 서버: 모든 수치 0
  if (server.isOffline) {
    return {
      server_id:   server.id,
      status:      'OFFLINE',
      cpu:         0,
      memory:      0,
      disk_io:     0,
      recorded_at: new Date(nowMs).toISOString(),
    }
  }

  const t = nowMs / 1000

  const TWO_PI     = 2 * Math.PI
  const LONG_FREQ  = TWO_PI / 300  // 5분 주기
  const SHORT_FREQ = TWO_PI / 60   // 1분 주기
  const MEM_FREQ   = TWO_PI / 420  // 7분 주기
  const DISK_FREQ  = TWO_PI / 120  // 2분 주기

  let cpu, memory, disk_io

  if (server.isStressed) {
    // STRESS 상태: CPU 폭주(95–99%), 디스크 I/O 요동(60–100%), 메모리도 상승
    cpu    = clamp(95 + Math.random() * 4)
    disk_io = clamp(60 + 35 * Math.abs(Math.sin(t * TWO_PI / 3)) + Math.random() * 5)
    memory  = clamp(
      server.mem_base + 15
      + 8 * Math.cos(t * MEM_FREQ + server.phase)
      + Math.random() * 5
    )
  } else {
    // 정상 상태: 삼각함수 파동
    cpu = clamp(
      server.cpu_base
      + 18 * Math.sin(t * LONG_FREQ  + server.phase)
      +  6 * Math.cos(t * SHORT_FREQ + server.phase)
      + Math.random() * 5
    )
    memory = clamp(
      server.mem_base
      + 12 * Math.cos(t * MEM_FREQ   + server.phase + Math.PI / 4)
      +  3 * Math.sin(t * SHORT_FREQ + server.phase)
      + Math.random() * 5
    )
    disk_io = clamp(
      server.disk_base
      + 22 * Math.sin(t * DISK_FREQ  + server.phase + Math.PI / 2)
      +  5 * Math.cos(t * SHORT_FREQ + server.phase)
      + Math.random() * 5
    )
  }

  return {
    server_id:   server.id,
    status:      server.status,
    cpu:         parseFloat(cpu.toFixed(1)),
    memory:      parseFloat(memory.toFixed(1)),
    disk_io:     parseFloat(disk_io.toFixed(1)),
    recorded_at: new Date(nowMs).toISOString(),
  }
}

// ─── ANSI 컬러 헬퍼 ───────────────────────────────────────────────────────────
const C = {
  reset:      '\x1b[0m',
  dim:        '\x1b[2m',
  bold:       '\x1b[1m',
  green:      '\x1b[32m',
  yellow:     '\x1b[33m',
  red:        '\x1b[31m',
  bgRed:      '\x1b[41m',
  bgYellow:   '\x1b[43m',
  cyan:       '\x1b[36m',
  white:      '\x1b[97m',
  black:      '\x1b[30m',
}

function colorByLevel(value) {
  if (value < 50) return C.green
  if (value < 75) return C.yellow
  return C.red
}

function bar(value) {
  const filled = Math.round(value / 10)
  return colorByLevel(value) + '█'.repeat(filled) + C.dim + '░'.repeat(10 - filled) + C.reset
}

// ─── 장애 이벤트 알림 출력 ────────────────────────────────────────────────────
function printAlert(level, message) {
  const ALERT_BORDER = '═'.repeat(72)
  if (level === 'stress') {
    console.log(`\n${C.bold}${C.bgYellow}${C.black} ⚠️  STRESS INJECTED ${C.reset}`)
    console.log(`${C.bold}${C.yellow}╔${ALERT_BORDER}╗${C.reset}`)
    console.log(`${C.bold}${C.yellow}║  ${message.padEnd(71)}║${C.reset}`)
    console.log(`${C.bold}${C.yellow}╚${ALERT_BORDER}╝${C.reset}\n`)
  } else if (level === 'down') {
    console.log(`\n${C.bold}${C.bgRed}${C.white} 🚨 SERVER DOWN ${C.reset}`)
    console.log(`${C.bold}${C.red}╔${ALERT_BORDER}╗${C.reset}`)
    console.log(`${C.bold}${C.red}║  ${message.padEnd(71)}║${C.reset}`)
    console.log(`${C.bold}${C.red}╚${ALERT_BORDER}╝${C.reset}\n`)
  } else if (level === 'recovery') {
    console.log(`\n${C.bold}${C.bgYellow}${C.black} ✅ SYSTEM RECOVERY ${C.reset}`)
    console.log(`${C.bold}${C.green}╔${ALERT_BORDER}╗${C.reset}`)
    console.log(`${C.bold}${C.green}║  ${message.padEnd(71)}║${C.reset}`)
    console.log(`${C.bold}${C.green}╚${ALERT_BORDER}╝${C.reset}\n`)
  }
}

// ─── 메트릭 테이블 출력 ───────────────────────────────────────────────────────
const BORDER = '─'.repeat(72)

function printMetrics(metrics) {
  const ts = metrics[0].recorded_at.replace('T', ' ').replace('Z', ' UTC')

  console.log(`\n${C.cyan}┌${BORDER}┐${C.reset}`)
  console.log(`${C.cyan}│${C.reset}  ${C.bold}${C.white}⏱  ${ts}${C.reset}`)
  console.log(`${C.cyan}├${BORDER}┤${C.reset}`)

  for (const m of metrics) {
    const server = SERVERS.find(s => s.id === m.server_id)
    const sid    = m.server_id.padEnd(22)
    const cpu    = String(m.cpu).padStart(5)
    const mem    = String(m.memory).padStart(5)
    const disk   = String(m.disk_io).padStart(5)

    let dot, rowPrefix = ''
    if (m.status === 'OFFLINE') {
      dot = `${C.red}●${C.reset}`
      rowPrefix = `${C.dim}`
    } else if (server?.isStressed) {
      dot = `${C.bold}${C.yellow}●${C.reset}`
    } else {
      dot = `${C.green}●${C.reset}`
    }

    console.log(
      `${C.cyan}│${C.reset} ${dot} ${rowPrefix}${C.white}${sid}${C.reset}` +
      `  CPU ${bar(m.cpu)} ${colorByLevel(m.cpu)}${cpu}%${C.reset}` +
      `  MEM ${bar(m.memory)} ${colorByLevel(m.memory)}${mem}%${C.reset}` +
      `  DISK ${bar(m.disk_io)} ${colorByLevel(m.disk_io)}${disk}%${C.reset}`
    )
  }

  console.log(`${C.cyan}└${BORDER}┘${C.reset}`)
}

// ─── 장애 주입 스케줄 ─────────────────────────────────────────────────────────
//  T+20s : kr-seoul-web-01  → STRESS (CPU 폭주)
//  T+40s : kr-jeju-ai-01   → OFFLINE
//  T+60s : 전체 복구 (Recovery)

const web01  = SERVERS.find(s => s.id === 'kr-seoul-web-01')
const jeju01 = SERVERS.find(s => s.id === 'kr-jeju-ai-01')

setTimeout(() => {
  web01.isStressed = true
  printAlert('stress', '⚠️  [STRESS INJECTED]  kr-seoul-web-01  CPU 폭주 시작! (isStressed → true)')
}, 20_000)

setTimeout(() => {
  jeju01.isOffline = true
  jeju01.status    = 'OFFLINE'
  printAlert('down', '🚨 [SERVER DOWN]  kr-jeju-ai-01  OFFLINE 상태 돌입! 모든 메트릭 → 0')
}, 40_000)

setTimeout(() => {
  web01.isStressed  = false
  jeju01.isOffline  = false
  jeju01.status     = 'ONLINE'
  printAlert('recovery', '✅ [RECOVERY]  전체 장애 해제 — 삼각함수 파동으로 정상 복구 완료')
}, 60_000)

// ─── 메인 루프 ────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}${C.cyan}🚀 PulseOps 시뮬레이터 시작${C.reset}  ${C.dim}(Ctrl+C 로 종료)${C.reset}`)
console.log(`${C.dim}  T+20s  kr-seoul-web-01  STRESS 주입`)
console.log(`  T+40s  kr-jeju-ai-01   OFFLINE 전환`)
console.log(`  T+60s  전체 RECOVERY${C.reset}\n`)

setInterval(() => {
  const metrics = SERVERS.map(s => generateMetrics(s, Date.now()))
  printMetrics(metrics)
}, 1000)

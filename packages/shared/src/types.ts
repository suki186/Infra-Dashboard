// Shared types between apps/web and apps/server
// WebSocket message types and other cross-cutting contracts go here
//
// Field names follow the Prisma schema (apps/server/prisma/schema.prisma)
// in camelCase. apps/web currently uses its own snake_case types
// (src/types/metrics.ts, src/types/terminal.ts, src/config/infrastructure.ts) —
// those are not replaced yet; the migration happens when the WebSocket client
// is wired up.

/** Prisma InfrastructureMetric row, shaped for the wire. */
export type ServerMetric = {
  serverId: string
  status: string
  cpuUsage: number
  memoryUsage: number
  diskIo: number
  createdAt: string
}

/** Log severity, matching apps/web's existing LogLevel. */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** Prisma InfrastructureLog row, shaped for the wire. */
export type LogEntry = {
  serverId: string
  level: LogLevel
  message: string
  createdAt: string
}

/**
 * Messages broadcast from apps/server to WebSocket clients.
 *
 * `metrics` carries a single server's snapshot rather than a batch of all
 * servers: server-level send-interval control (step 5) lets each server
 * push metrics on its own schedule, so ticks are not synchronized across
 * servers and must be broadcast independently as they occur.
 */
export type WSMessage =
  | { type: 'metrics'; payload: ServerMetric }
  | { type: 'log'; payload: LogEntry }

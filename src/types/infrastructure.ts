export type ServerMetric = {
  server_id:    string
  status:       string
  cpu_usage:    number
  memory_usage: number
  disk_io:      number
}

export type MetricsMap = Record<string, ServerMetric>

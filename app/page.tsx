'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/src/utils/supabase'
// TODO: 연결 확인 후 제거
import SupabaseConnectionTest from '@/src/components/common/SupabaseConnectionTest'

// ─── 타입 ─────────────────────────────────────────────────────────────────────
type ServerMetric = {
  server_id:    string
  status:       string
  cpu_usage:    number
  memory_usage: number
  disk_io:      number
}

// server_id 를 키로 각 서버의 최신 메트릭 1건만 보유
type MetricsMap = Record<string, ServerMetric>

// ─── 파생 값 계산 헬퍼 ────────────────────────────────────────────────────────
function deriveStats(metrics: MetricsMap) {
  const all     = Object.values(metrics)
  const online  = all.filter(m => m.status === 'ONLINE')
  const offline = all.filter(m => m.status === 'OFFLINE')

  const serverCount = all.length === 0 ? '—' : String(online.length)

  const avgCpu =
    online.length === 0
      ? '—'
      : (online.reduce((s, m) => s + m.cpu_usage, 0) / online.length).toFixed(1)

  const maxCpu = online.length > 0 ? Math.max(...online.map(m => m.cpu_usage)) : 0
  const risk =
    all.length === 0        ? { label: '—',   color: 'text-slate-400' }
    : offline.length > 0   ? { label: '위험', color: 'text-red-400'   }
    : maxCpu >= 90         ? { label: '위험', color: 'text-red-400'   }
    : maxCpu >= 70         ? { label: '경고', color: 'text-amber-400' }
    :                        { label: '정상', color: 'text-emerald-400' }

  const alertCount = offline.length + online.filter(m => m.cpu_usage >= 90).length

  return { serverCount, avgCpu, risk, alertCount, onlineCount: online.length }
}

// ─── 시스템 상태 헤더 문구 ────────────────────────────────────────────────────
function systemStatusLabel(risk: { label: string }) {
  if (risk.label === '위험') return { text: '시스템 상태: 위험',  dot: 'text-red-400'    }
  if (risk.label === '경고') return { text: '시스템 상태: 경고',  dot: 'text-amber-400'  }
  if (risk.label === '정상') return { text: '시스템 상태: 정상',  dot: 'text-emerald-400'}
  return                             { text: '시스템 상태: 대기중', dot: 'text-slate-400' }
}

// ─── 페이지 컴포넌트 ──────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [metrics, setMetrics]       = useState<MetricsMap>({})
  const [lastUpdated, setLastUpdated] = useState<string>('—')

  // ─── Supabase Realtime 구독 ─────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('infrastructure_metrics_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'infrastructure_metrics' },
        (payload) => {
          const row = payload.new as ServerMetric
          console.log('📥 수신된 메트릭:', row)

          setMetrics(prev => ({ ...prev, [row.server_id]: row }))
          setLastUpdated(new Date().toLocaleTimeString('ko-KR'))
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('📡 Supabase 실시간 채널 연결 성공!')
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // ─── 파생 상태 ───────────────────────────────────────────────────────────
  const { serverCount, avgCpu, risk, alertCount, onlineCount } = deriveStats(metrics)
  const sysStatus = systemStatusLabel(risk)

  const summaryCards = [
    {
      title: '배포된 서버 수',
      value: serverCount,
      unit:  serverCount === '—' ? '' : '대',
      sub:   `온라인 ${onlineCount}대 모니터링 중`,
      color: 'text-blue-400',
    },
    {
      title: '평균 CPU',
      value: avgCpu,
      unit:  avgCpu === '—' ? '' : '%',
      sub:   '전체 온라인 서버 평균',
      color: 'text-emerald-400',
    },
    {
      title: '시스템 위험도',
      value: risk.label,
      unit:  '',
      sub:   `알림 ${alertCount}건 발생 중`,
      color: risk.color,
    },
  ]

  return (
    <div className="flex flex-col flex-1 p-6 gap-6">
      {/* 상단 헤더 */}
      <header className="flex items-center justify-between px-5 py-3 rounded-xl bg-slate-800 border border-slate-700">
        <div className="flex items-center gap-3">
          <span className={`text-lg leading-none ${sysStatus.dot}`}>●</span>
          <span className="text-sm font-semibold text-slate-100">
            {sysStatus.text}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <SupabaseConnectionTest />
          <div className="flex items-center gap-6 text-xs text-slate-400">
            <span>
              모니터링 서버{' '}
              <strong className="text-slate-200 font-semibold">
                {serverCount === '—' ? '—' : `${serverCount} 대`}
              </strong>
            </span>
            <span>
              마지막 갱신{' '}
              <strong className="text-slate-200 font-semibold">{lastUpdated}</strong>
            </span>
            <span>
              활성 알림{' '}
              <strong className={`font-semibold ${alertCount > 0 ? 'text-red-400' : 'text-slate-200'}`}>
                {alertCount} 건
              </strong>
            </span>
          </div>
        </div>
      </header>

      {/* 요약 카드 3열 */}
      <section className="grid grid-cols-3 gap-4">
        {summaryCards.map((card) => (
          <div
            key={card.title}
            className="flex flex-col gap-2 px-6 py-5 rounded-xl bg-slate-800 border border-slate-700"
          >
            <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">
              {card.title}
            </p>
            <div className="flex items-end gap-1">
              <span className={`text-4xl font-bold tabular-nums ${card.color}`}>
                {card.value}
              </span>
              {card.unit && (
                <span className="text-base text-slate-400 mb-1">{card.unit}</span>
              )}
            </div>
            <p className="text-xs text-slate-500">{card.sub}</p>
          </div>
        ))}
      </section>

      {/* 메인 영역: 차트(70%) + 챗봇(30%) */}
      <section className="flex gap-4 flex-1 min-h-0">
        {/* 차트 영역 */}
        <div className="flex flex-col gap-3 flex-[7] rounded-xl bg-slate-800 border border-slate-700 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              실시간 인프라 메트릭 스트리밍
            </h2>
            <span className="text-xs text-slate-500">Chart.js 연동 예정</span>
          </div>
          <div className="flex-1 flex items-center justify-center rounded-lg border border-dashed border-slate-600 min-h-64">
            <p className="text-slate-600 text-sm">차트 영역</p>
          </div>
        </div>

        {/* 챗봇 영역 */}
        <div className="flex flex-col gap-3 flex-[3] rounded-xl bg-slate-800 border border-slate-700 p-5">
          <div className="flex items-center gap-2">
            <span className="text-base">🤖</span>
            <h2 className="text-sm font-semibold text-slate-100">
              Pulse Doctor
            </h2>
          </div>
          <div className="flex-1 flex items-center justify-center rounded-lg border border-dashed border-slate-600 min-h-64">
            <p className="text-slate-600 text-sm">챗봇 영역</p>
          </div>
          <div className="h-10 rounded-lg bg-slate-700 border border-slate-600" />
        </div>
      </section>
    </div>
  )
}

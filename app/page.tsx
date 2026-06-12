'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/src/utils/supabase'
import type { MetricsMap, ServerMetric } from '@/src/config/infrastructure'
import { deriveStats, systemStatusLabel } from '@/src/utils/infrastructureHelpers'
import RealtimeChart from '@/src/components/dashboard/RealtimeChart'

export default function DashboardPage() {
  const [metrics, setMetrics]         = useState<MetricsMap>({})
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
          setMetrics(prev => ({ ...prev, [row.server_id]: row }))
          setLastUpdated(new Date().toLocaleTimeString('ko-KR'))
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('📡 Supabase 실시간 채널 연결 성공!')
        }
      })

    return () => { supabase.removeChannel(channel) }
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
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden p-4 md:p-6 gap-4 md:gap-6 w-full">

      {/* 헤더 */}
      <header className="shrink-0 flex flex-wrap items-center justify-between gap-y-2 px-5 py-3 rounded-xl bg-slate-800 border border-slate-700">
        <div className="flex items-center gap-3 shrink-0">
          <span className={`text-lg leading-none ${sysStatus.dot}`}>●</span>
          <span className="text-sm font-semibold text-slate-100">
            {sysStatus.text}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-400">
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
      </header>

      {/* 요약 카드 */}
      <section className="shrink-0 grid grid-cols-1 md:grid-cols-3 gap-4">
        {summaryCards.map((card) => (
          <div
            key={card.title}
            className="flex flex-col gap-1.5 px-4 py-3 md:px-6 md:py-4 rounded-xl bg-slate-800 border border-slate-700"
          >
            <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">
              {card.title}
            </p>
            <div className="flex items-end gap-1">
              <span className={`text-3xl md:text-4xl font-bold tabular-nums ${card.color}`}>
                {card.value}
              </span>
              {card.unit && (
                <span className="text-base text-slate-400 mb-0.5">{card.unit}</span>
              )}
            </div>
            <p className="text-xs text-slate-500">{card.sub}</p>
          </div>
        ))}
      </section>

      {/* 메인 영역: 차트(70%) + 챗봇(30%) */}
      <section className="flex flex-col lg:flex-row gap-4 md:gap-6 flex-1 min-h-0 overflow-hidden">

        {/* 차트 영역 */}
        <div className="flex flex-col gap-3 min-w-0 w-full lg:flex-[7] min-h-64 lg:min-h-0 rounded-xl bg-slate-800 border border-slate-700 p-4 md:p-5">
          <h2 className="text-sm font-semibold text-slate-100 shrink-0">
            실시간 인프라 메트릭 스트리밍
          </h2>
          <div className="flex-1 min-h-0">
            <RealtimeChart />
          </div>
        </div>

        {/* 챗봇 영역 */}
        <div className="flex flex-col gap-3 min-w-0 w-full lg:flex-[3] rounded-xl bg-slate-800 border border-slate-700 p-4 md:p-5">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-base">🤖</span>
            <h2 className="text-sm font-semibold text-slate-100">
              Pulse Doctor
            </h2>
          </div>
          <div className="flex-1 flex items-center justify-center rounded-lg border border-dashed border-slate-600 min-h-36 lg:min-h-0">
            <p className="text-slate-600 text-sm">챗봇 영역</p>
          </div>
          <div className="h-10 shrink-0 rounded-lg bg-slate-700 border border-slate-600" />
        </div>

      </section>
    </div>
  )
}

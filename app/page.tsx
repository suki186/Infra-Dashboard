'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/src/utils/supabase'
import type { MetricsMap, ServerMetric } from '@/src/config/infrastructure'
import { deriveStats, systemStatusLabel } from '@/src/utils/infrastructureHelpers'
import RealtimeChart from '@/src/components/dashboard/RealtimeChart'
import { LogTerminal } from '@/src/components/dashboard/LogTerminal'
import type { LogTerminalHandle } from '@/src/types/terminal'
import PulseDoctor from '@/src/components/chatbot/PulseDoctor'

export default function DashboardPage() {
  const [metrics, setMetrics]         = useState<MetricsMap>({})
  const [lastUpdated, setLastUpdated] = useState<string>('—')

  // logTerminalRef : RefObject이므로 state 가 아님 → metrics 갱신이 PulseDoctor 를 깨워도
  //                  이 ref 를 타고 로그를 읽는 것은 추가 re-render 없이 수행된다.
  const logTerminalRef = useRef<LogTerminalHandle>(null)

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

  // ─── 장애 주입 핸들러 ─────────────────────────────────────────────────────
  function handleFaultInject() {
    setMetrics(prev => ({
      ...prev,
      'kr-seoul-web-01': {
        server_id:    'kr-seoul-web-01',
        status:       'ONLINE',
        cpu_usage:    99,
        memory_usage: 88,
        disk_io:      97,
      },
    }))
    logTerminalRef.current?.injectLog({
      level:     'ERROR',
      server_id: 'kr-seoul-web-01',
      message:   '[CRITICAL ERROR] CPU OVERLOAD: 99% — 즉각 조치 필요',
    })
  }

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
          <button
            onClick={handleFaultInject}
            data-testid="fault-inject-btn"
            className="ml-4 px-3 py-1 rounded-md text-xs font-medium bg-red-900/40 border border-red-700/50 text-red-400 hover:bg-red-800/50 transition-colors"
          >
            장애 주입
          </button>
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

        {/* logTerminalRef: RefObject 전달 — state 가 아니므로 PulseDoctor re-render 없음 */}
        <PulseDoctor metrics={metrics} logTerminalRef={logTerminalRef} />

      </section>

      {/* 로그 터미널 — shrink-0 고정 높이, 자체 Supabase 구독으로 완전 격리 */}
      <LogTerminal ref={logTerminalRef} />

    </div>
  )
}

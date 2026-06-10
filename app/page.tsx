const summaryCards = [
  {
    title: '배포된 서버 수',
    value: '—',
    unit: '대',
    sub: '모니터링 중',
    color: 'text-blue-400',
  },
  {
    title: '평균 CPU',
    value: '—',
    unit: '%',
    sub: '전체 평균',
    color: 'text-emerald-400',
  },
  {
    title: '시스템 위험도',
    value: '—',
    unit: '',
    sub: '현재 상태',
    color: 'text-amber-400',
  },
]

export default function DashboardPage() {
  return (
    <div className="flex flex-col flex-1 p-6 gap-6">
      {/* 상단 헤더 */}
      <header className="flex items-center justify-between px-5 py-3 rounded-xl bg-slate-800 border border-slate-700">
        <div className="flex items-center gap-3">
          <span className="text-emerald-400 text-lg leading-none">●</span>
          <span className="text-sm font-semibold text-slate-100">
            시스템 상태: 정상
          </span>
        </div>
        <div className="flex items-center gap-6 text-xs text-slate-400">
          <span>
            모니터링 서버{' '}
            <strong className="text-slate-200 font-semibold">— 대</strong>
          </span>
          <span>
            마지막 갱신{' '}
            <strong className="text-slate-200 font-semibold">—</strong>
          </span>
          <span>
            활성 알림{' '}
            <strong className="text-slate-200 font-semibold">0 건</strong>
          </span>
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

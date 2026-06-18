'use client'

import { memo } from 'react'
import { SERVER_STYLES, SERVER_IDS } from '@/src/config/infrastructure'
import { useChartPaint } from '@/src/hooks/useChartPaint'
import { Y_AXIS_WIDTH } from './RealtimeChart.utils'

const RealtimeChart = memo(function RealtimeChart() {
  const {
    canvasRef, overlayRef, loadingRef,
    scrollerRef, chartWrapperRef, sentinelRef, yAxisCanvasRef,
    visibleServers, toggleServer, handleScroll,
  } = useChartPaint()

  return (
    <div className="flex flex-col w-full h-full min-h-0 gap-2">

      {/* 다중 서버 필터 범례 — 스크롤 컨테이너 외부 고정 */}
      <div className="shrink-0 flex items-center gap-1 px-1">
        {SERVER_IDS.map(id => {
          const { label, color } = SERVER_STYLES[id]
          const isOn = visibleServers[id] ?? true
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggleServer(id)}
              title={isOn ? `${label} 숨기기` : `${label} 표시`}
              className={[
                'flex items-center gap-1.5 px-2 py-0.5 rounded',
                'cursor-pointer select-none transition-all duration-150',
                isOn
                  ? 'bg-slate-800/60 hover:bg-slate-700/60'
                  : 'bg-transparent hover:bg-slate-800/40 opacity-40',
              ].join(' ')}
            >
              <span
                className="w-3 h-3 rounded-sm shrink-0 transition-colors duration-150"
                style={{ backgroundColor: isOn ? color : '#475569' }}
              />
              <span className="text-xs text-slate-300">{label}</span>
            </button>
          )
        })}
      </div>

      {/* 차트 영역 */}
      <div className="relative flex-1 min-h-0">

        {/* 초기 오버레이 (데이터 없음) */}
        <div
          ref={overlayRef}
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none"
        >
          <span className="text-slate-600 text-2xl">📡</span>
          <p className="text-slate-600 text-sm">시뮬레이터를 실행하면 차트가 표시됩니다</p>
          <p className="text-slate-700 text-xs font-mono">node scripts/simulator.mjs</p>
        </div>

        {/* 과거 데이터 로딩 인디케이터 */}
        <div
          ref={loadingRef}
          className="absolute top-0 z-20 items-center gap-1.5 px-2 py-0.5 rounded-br
                     bg-slate-900/80 border-r border-b border-slate-700 hidden"
          style={{ left: Y_AXIS_WIDTH }}
        >
          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping shrink-0" />
          <span className="text-[10px] text-blue-400/80 font-mono whitespace-nowrap">
            과거 데이터 로딩 중…
          </span>
        </div>

        {/* 고정 Y축 + 스크롤 차트 — flex 가로 배치 */}
        <div className="flex w-full h-full">
          <div className="shrink-0 relative" style={{ width: Y_AXIS_WIDTH }}>
            <canvas ref={yAxisCanvasRef} className="absolute inset-0 block w-full h-full" />
          </div>

          <div
            ref={scrollerRef}
            className="flex-1 h-full overflow-x-auto"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 transparent' }}
            onScroll={handleScroll}
          >
            <div
              ref={chartWrapperRef}
              style={{ minWidth: '100%', height: '100%', position: 'relative' }}
            >
              <div ref={sentinelRef} className="absolute left-0 top-0 w-px h-full pointer-events-none" />
              <canvas ref={canvasRef} className="w-full h-full block invisible" />
            </div>
          </div>

        </div>
      </div>
    </div>
  )
})

export default RealtimeChart

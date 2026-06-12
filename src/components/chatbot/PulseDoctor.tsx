export default function PulseDoctor() {
  return (
    <div className="flex flex-col gap-3 min-w-0 w-full lg:flex-[3] rounded-xl bg-slate-800 border border-slate-700 p-4 md:p-5">

      {/* 헤더 */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-base">🤖</span>
        <h2 className="text-sm font-semibold text-slate-100">Pulse Doctor</h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse" />
          준비 중
        </span>
      </div>

      {/* 스켈레톤 말풍선 */}
      <div className="flex flex-col gap-4 flex-1 overflow-hidden min-h-36 lg:min-h-0 py-1">

        {/* AI ← 왼쪽 */}
        <div className="flex gap-2 items-start">
          <div className="w-6 h-6 rounded-full bg-slate-700 animate-pulse shrink-0 mt-0.5" />
          <div className="flex flex-col gap-2 max-w-[80%]">
            <div className="h-2.5 bg-slate-700 rounded-full animate-pulse w-48" />
            <div className="h-2.5 bg-slate-700 rounded-full animate-pulse w-32" />
          </div>
        </div>

        {/* 사용자 → 오른쪽 */}
        <div className="flex gap-2 items-start justify-end">
          <div className="flex flex-col gap-2 items-end max-w-[75%]">
            <div className="h-2.5 bg-slate-600 rounded-full animate-pulse w-40" />
            <div className="h-2.5 bg-slate-600 rounded-full animate-pulse w-24" />
          </div>
        </div>

        {/* AI ← 왼쪽 (멀티라인) */}
        <div className="flex gap-2 items-start">
          <div className="w-6 h-6 rounded-full bg-slate-700 animate-pulse shrink-0 mt-0.5" />
          <div className="flex flex-col gap-2 max-w-[80%]">
            <div className="h-2.5 bg-slate-700 rounded-full animate-pulse w-52" />
            <div className="h-2.5 bg-slate-700 rounded-full animate-pulse w-44" />
            <div className="h-2.5 bg-slate-700 rounded-full animate-pulse w-36" />
          </div>
        </div>

        {/* AI ← 타이핑 인디케이터 */}
        <div className="flex gap-2 items-center">
          <div className="w-6 h-6 rounded-full bg-slate-700 animate-pulse shrink-0" />
          <div className="flex items-center gap-1 px-3 py-2 bg-slate-700 rounded-xl">
            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
          </div>
        </div>

      </div>

      {/* 입력 필드 */}
      <div className="shrink-0 flex gap-2 items-center">
        <div className="flex-1 h-9 rounded-lg bg-slate-700/60 border border-slate-600 animate-pulse" />
        <div className="w-9 h-9 rounded-lg bg-slate-700 animate-pulse shrink-0" />
      </div>

    </div>
  )
}

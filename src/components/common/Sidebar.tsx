'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  Bot,
  ScrollText,
  Settings,
  BarChart3,
} from 'lucide-react'

const navItems = [
  { href: '/',         icon: Activity,   label: '실시간 관제' },
  { href: '/chatbot',  icon: Bot,        label: 'AI 진단 챗봇' },
  { href: '/logs',     icon: ScrollText, label: '시스템 로그' },
  { href: '/settings', icon: Settings,   label: '설정' },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="flex flex-col w-64 min-h-screen bg-slate-950 border-r border-slate-800">
      <div className="flex items-center gap-3 px-6 py-6 border-b border-slate-800">
        <BarChart3 className="text-blue-400 shrink-0" size={24} />
        <span className="text-lg font-bold tracking-tight text-white">
          PulseOps
        </span>
      </div>

      <nav className="flex flex-col gap-1 px-3 py-4 flex-1">
        {navItems.map(({ href, icon: Icon, label }) => {
          const isActive = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={[
                'flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
              ].join(' ')}
            >
              <Icon size={18} className="shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="px-6 py-4 border-t border-slate-800">
        <p className="text-xs text-slate-600">PulseOps v0.1.0</p>
      </div>
    </aside>
  )
}

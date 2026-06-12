import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import Sidebar from '@/src/components/common/Sidebar'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'PulseOps - 실시간 인프라 관제 & AI 진단 SaaS',
  description: '실시간 대용량 메트릭 스트리밍 및 RAG 기반 AI 진단 플랫폼',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      {/* h-full: */}
      <body className="h-full flex bg-slate-900 text-slate-100 antialiased overflow-hidden">
        <Sidebar />
        {/* overflow-hidden */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-900">
          {children}
        </main>
      </body>
    </html>
  )
}

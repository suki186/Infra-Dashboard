'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/src/utils/supabase'

type Status = 'pending' | 'success' | 'error'

export default function SupabaseConnectionTest() {
  const [status, setStatus] = useState<Status>('pending')
  const [message, setMessage] = useState('Supabase 연결 확인 중...')

  useEffect(() => {
    supabase.auth.getSession().then(({ error }) => {
      if (error) {
        console.error('❌ Supabase 연결 실패:', error.message)
        setStatus('error')
        setMessage(`연결 실패: ${error.message}`)
      } else {
        console.log('✅ Supabase 연결 성공!')
        setStatus('success')
        setMessage('✅ Supabase 연결 성공!')
      }
    })
  }, [])

  const styles: Record<Status, string> = {
    pending: 'bg-slate-700 text-slate-400 border-slate-600',
    success: 'bg-emerald-950 text-emerald-400 border-emerald-800',
    error:   'bg-red-950 text-red-400 border-red-800',
  }

  return (
    <div className={`px-4 py-2 rounded-lg border text-xs font-mono ${styles[status]}`}>
      {message}
    </div>
  )
}

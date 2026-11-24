/* Funções e contexto compartilhados pelos relatórios com gráficos. */
import { createContext, type ReactNode } from 'react'

/* ---------- datas (AAAA-MM-DD, horário local) ---------- */
export const pad = (n: number) => String(n).padStart(2, '0')
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const parseDay = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y!, m! - 1, d!) }
export const addDays = (iso: string, n: number) => { const d = parseDay(iso); d.setDate(d.getDate() + n); return ymd(d) }
export const daysBetween = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 864e5) + 1
export const fmtDay = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }

/* ---------- dica flutuante ---------- */
export type Tip = { x: number; y: number; body: ReactNode } | null
export const TipCtx = createContext<(t: Tip) => void>(() => {})
export function tipProps(set: (t: Tip) => void, body: () => ReactNode) {
  return {
    onMouseMove: (e: React.MouseEvent) => set({ x: e.clientX, y: e.clientY, body: body() }),
    onMouseLeave: () => set(null),
  }
}

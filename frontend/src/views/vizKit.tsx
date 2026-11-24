/* Peças compartilhadas pelos relatórios com gráficos (Desempenho, Por técnico). */
import { useContext, type ReactNode } from 'react'
import { TipCtx, tipProps, type Tip } from './vizCore'

export function TipBox({ tip }: { tip: Tip }) {
  if (!tip) return null
  return <div className="pf-tip" role="tooltip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 14 }}>{tip.body}</div>
}

/* ---------- cartão e barras horizontais ---------- */
export function Card({ title, hint, tone, children, className }: { title: string; hint?: string; tone?: 'tto' | 'ttr'; children: ReactNode; className?: string }) {
  return (
    <section className={`pf-card${tone ? ' ' + tone : ''}${className ? ' ' + className : ''}`}>
      <header><h4>{tone && <i className={`pf-key ${tone}`} aria-hidden />}{title}</h4>{hint && <p>{hint}</p>}</header>
      {children}
    </section>
  )
}

export interface BarRow { id: string | number; label: string; value: number; tip: ReactNode; sub?: string }
export function HBars({ rows, tone, fmt, onPick, picked }: { rows: BarRow[]; tone: 'tto' | 'ttr' | 'qty' | 'par'; fmt: (v: number) => string; onPick?: (id: string | number) => void; picked?: string | number | null }) {
  const setTip = useContext(TipCtx)
  if (!rows.length) return <p className="empty">Sem dados.</p>
  const max = Math.max(...rows.map(r => r.value), 0)
  return (
    <div className="pf-hbars">
      {rows.map(r => {
        const inner = <>
          <span className="pf-hbar-label" title={r.sub ? `${r.label} — ${r.sub}` : r.label}>{r.label}{r.sub && <small>{r.sub}</small>}</span>
          <span className="pf-hbar-track">
            <span className={`pf-fill ${tone}`} style={{ '--p': max ? Math.max(0.01, r.value / max) : 0 } as React.CSSProperties} />
            <span className="pf-hbar-val">{fmt(r.value)}</span>
          </span>
        </>
        return onPick
          ? <button key={r.id} type="button" className={`pf-hbar pick${picked === r.id ? ' on' : ''}`} aria-pressed={picked === r.id} onClick={() => onPick(r.id)} {...tipProps(setTip, () => r.tip)}>{inner}</button>
          : <div key={r.id} className="pf-hbar" {...tipProps(setTip, () => r.tip)}>{inner}</div>
      })}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

export interface ReportsMenuItem { id: string; label: string; hint?: string }

/** Botão "Relatórios ▾" à direita das abas: abre um menu e navega para o relatório escolhido. */
export default function ReportsMenu({ items, active, onSelect }: { items: ReportsMenuItem[]; active: string | null; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.rm-btn')?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const current = items.find(i => i.id === active)
  return (
    <div className="rm" ref={root}>
      <button type="button" className={`rm-btn${current ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}
        title={current ? `Relatórios — ${current.label}` : 'Relatórios'} aria-label={current ? `Relatórios (aberto: ${current.label})` : 'Relatórios'}>
        <span aria-hidden>📊</span>
      </button>
      {open && (
        <div className="rm-pop" role="menu">
          {items.map(i => (
            <button key={i.id} type="button" role="menuitem" className={i.id === active ? 'on' : ''} onClick={() => { onSelect(i.id); setOpen(false) }}>
              <span className="rm-label">{i.label}</span>
              {i.hint && <span className="rm-hint">{i.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

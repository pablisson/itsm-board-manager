import { useEffect, useRef, useState } from 'react'

export type SystemId = 'itsm' | 'pm'
const SYSTEMS: { id: SystemId; title: string; hint: string; hash: string; icon: string }[] = [
  { id: 'itsm', title: 'Board de chamados · ITSM', hint: 'Kanban, entidades, planejamento e relatórios de chamados', hash: 'board', icon: '🎫' },
  { id: 'pm', title: 'Gestão de Projetos', hint: 'Projetos, tarefas, dependências, marcos e Gantt', hash: 'pm', icon: '📁' },
]

/** O título da página é um botão que troca de sistema. */
export default function SystemMenu({ current }: { current: SystemId }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.sys-btn')?.focus() } }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  const cur = SYSTEMS.find(s => s.id === current)!
  return (
    <div className="sys" ref={root}>
      <h1>
        <button type="button" className="sys-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} title="Trocar de sistema">
          {cur.title} <span className="sys-caret" aria-hidden>▾</span>
        </button>
      </h1>
      {open && (
        <div className="sys-pop" role="menu" aria-label="Sistemas">
          {SYSTEMS.map(s => (
            <button key={s.id} type="button" role="menuitem" className={s.id === current ? 'on' : ''}
              onClick={() => { setOpen(false); if (s.id !== current) location.hash = s.hash }}>
              <span className="sys-ico" aria-hidden>{s.icon}</span>
              <span><span className="sys-title">{s.title}</span><span className="sys-hint">{s.hint}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

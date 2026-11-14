import { useEffect, useMemo, useRef, useState } from 'react'
import type { PmPerson } from './types'

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')

export function PersonChips({ people, max = 3 }: { people: PmPerson[]; max?: number }) {
  if (!people.length) return <span className="pm-muted">—</span>
  const shown = people.slice(0, max)
  return (
    <span className="pm-people" title={people.map(p => p.name).join(', ')}>
      {shown.map(p => <span key={p.id} className="pm-avatar" aria-hidden>{initials(p.name)}</span>)}
      <span className="pm-people-names">{people.length === 1 ? people[0]!.name : `${people.length} responsáveis`}</span>
    </span>
  )
}

/** Escolha de um ou mais responsáveis (técnicos do ITSM). Grava ao fechar. */
export default function AssigneePicker({ users, selected, onSave, disabled, children }: {
  users: PmPerson[]; selected: PmPerson[]; onSave: (people: PmPerson[]) => void; disabled?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<Map<number, PmPerson>>(new Map())
  const [q, setQ] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const all = useMemo(() => {
    const m = new Map(users.map(u => [u.id, u]))
    for (const s of selected) if (!m.has(s.id)) m.set(s.id, s) // responsável que não está mais na lista do ITSM
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [users, selected])
  const list = all.filter(u => !q.trim() || u.name.toLowerCase().includes(q.trim().toLowerCase()))

  const close = (save: boolean) => {
    setOpen(false)
    if (!save) return
    const next = [...sel.values()]
    const same = next.length === selected.length && next.every(p => selected.some(s => s.id === p.id))
    if (!same) onSave(next)
  }

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close(true) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(false) } }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true) }
  })

  return (
    <div className="pm-picker" ref={root}>
      <button type="button" className="pm-cellbtn" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { if (open) close(true); else { setSel(new Map(selected.map(s => [s.id, s]))); setQ(''); setOpen(true) } }}>
        {children}
      </button>
      {open && (
        <div className="pm-pop" role="dialog" aria-label="Responsáveis">
          <input ref={search} type="search" placeholder="Buscar técnico…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="pm-pop-list">
            {list.map(u => (
              <label key={u.id} className="pm-check">
                <input type="checkbox" checked={sel.has(u.id)} onChange={e => setSel(m => { const n = new Map(m); if (e.target.checked) n.set(u.id, u); else n.delete(u.id); return n })} />
                <span>{u.name}</span>
              </label>
            ))}
            {list.length === 0 && <p className="empty">Nenhum técnico encontrado.</p>}
          </div>
          <div className="pm-pop-foot">
            <span className="pm-muted">{sel.size} selecionado(s)</span>
            <button type="button" className="link" onClick={() => setSel(new Map())}>Limpar</button>
            <button type="button" className="primary sm" onClick={() => close(true)}>OK</button>
          </div>
        </div>
      )}
    </div>
  )
}

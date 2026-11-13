import { useEffect, useMemo, useRef, useState } from 'react'

/** Id reservado para "Sem técnico" (tickets sem técnico atribuído). */
export const NO_TECH = -1

export interface TechStat { id: number; name: string; open: number; blocked: number; done: number; critical: number }

type Props = {
  techs: TechStat[]
  /** null = todos (inclui técnicos que aparecerem depois). */
  selected: Set<number> | null
  onChange: (s: Set<number> | null) => void
}

export default function TechFilter({ techs, selected, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const allIds = useMemo(() => techs.map(t => t.id), [techs])
  const isOn = (id: number) => selected === null || selected.has(id)
  const count = selected === null ? techs.length : allIds.filter(id => selected.has(id)).length

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? techs.filter(t => t.name.toLowerCase().includes(s)) : techs
  }, [techs, q])

  const set = (ids: Iterable<number>) => {
    const s = new Set(ids)
    onChange(allIds.every(id => s.has(id)) ? null : s)
  }
  const toggle = (id: number) => {
    const s = new Set(selected ?? allIds)
    if (s.has(id)) s.delete(id); else s.add(id)
    set(s)
  }
  // ações que respeitam a busca: "Todos"/"Nenhum" agem só sobre os técnicos visíveis
  const selectVisible = (on: boolean) => {
    const s = new Set(selected ?? allIds)
    visible.forEach(t => on ? s.add(t.id) : s.delete(t.id))
    set(s)
  }
  const withCritical = techs.filter(t => t.critical > 0)

  const label = selected === null ? 'Todos os técnicos' : count === 0 ? 'Nenhum técnico' : count === 1
    ? techs.find(t => selected.has(t.id))?.name ?? '1 técnico' : `${count} de ${techs.length} técnicos`

  return (
    <div className="tf" ref={root}>
      <button type="button" className={`tf-btn${selected !== null ? ' active' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="dialog">
        <span className="tf-icon" aria-hidden>👤</span>
        <span className="tf-label">{label}</span>
        <span className="chev" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {selected !== null && (
        <button type="button" className="tf-clear" title="Limpar filtro de técnicos" aria-label="Limpar filtro de técnicos" onClick={() => onChange(null)}>×</button>
      )}

      {open && (
        <div className="tf-pop" role="dialog" aria-label="Filtrar técnicos">
          <input ref={search} type="search" className="tf-search" placeholder="Buscar técnico…" value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && visible.length === 1) toggle(visible[0]!.id) }} />
          <div className="tf-quick">
            <button type="button" onClick={() => selectVisible(true)}>{q ? 'Marcar visíveis' : 'Todos'}</button>
            <button type="button" onClick={() => selectVisible(false)}>{q ? 'Desmarcar visíveis' : 'Nenhum'}</button>
            <button type="button" onClick={() => set(withCritical.map(t => t.id))} disabled={withCritical.length === 0}
              title="Só técnicos com tickets acima do limite crítico de tempo aberto">Com críticos ({withCritical.length})</button>
          </div>
          <div className="tf-head"><span>Técnico</span><span title="Em andamento · Bloqueados · Completos">And. · Bloq. · Compl.</span></div>
          <ul className="tf-list">
            {visible.map(t => (
              <li key={t.id} className={isOn(t.id) ? 'on' : ''}>
                <label>
                  <input type="checkbox" checked={isOn(t.id)} onChange={() => toggle(t.id)} />
                  <span className={`tf-name${t.id === NO_TECH ? ' muted' : ''}`} title={t.name}>{t.name}</span>
                  {t.critical > 0 && <span className="pill crit" title={`${t.critical} ticket(s) em andamento acima do limite crítico`}>{t.critical}</span>}
                  <span className="tf-nums">
                    <b className="n-blue">{t.open}</b>·<b className="n-red">{t.blocked}</b>·<b className="n-green">{t.done}</b>
                  </span>
                </label>
                <button type="button" className="tf-only" onClick={() => set([t.id])} title={`Mostrar só ${t.name}`}>só</button>
              </li>
            ))}
            {visible.length === 0 && <li className="empty">Nenhum técnico encontrado.</li>}
          </ul>
          <div className="tf-foot">
            <span className="muted">{count} de {techs.length} selecionado(s)</span>
            <button type="button" className="primary" onClick={() => setOpen(false)}>Pronto</button>
          </div>
        </div>
      )}
    </div>
  )
}

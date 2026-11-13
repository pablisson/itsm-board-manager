import { useEffect, useMemo, useRef, useState } from 'react'

export type FilterKey = string | number

export interface FilterItem<K extends FilterKey> {
  id: K
  name: string
  /** texto completo no tooltip (ex.: caminho da entidade) */
  title?: string
  /** item especial fixado no topo (ex.: "Sem técnico") */
  special?: boolean
  open: number; blocked: number; done: number; critical: number
}

type Props<K extends FilterKey> = {
  items: FilterItem<K>[]
  /** null = todos (inclui itens que aparecerem depois). */
  selected: Set<K> | null
  onChange: (s: Set<K> | null) => void
  /** substantivos para os rótulos */
  singular: string
  plural: string
  icon: string
  /** gênero do "Todos/Todas" */
  feminine?: boolean
}

export default function MultiFilter<K extends FilterKey>({ items, selected, onChange, singular, plural, icon, feminine }: Props<K>) {
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

  const allIds = useMemo(() => items.map(t => t.id), [items])
  const isOn = (id: K) => selected === null || selected.has(id)
  const count = selected === null ? items.length : allIds.filter(id => selected.has(id)).length

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? items.filter(t => `${t.name} ${t.title ?? ''}`.toLowerCase().includes(s)) : items
  }, [items, q])

  const set = (ids: Iterable<K>) => {
    const s = new Set(ids)
    onChange(allIds.every(id => s.has(id)) ? null : s)
  }
  const toggle = (id: K) => {
    const s = new Set(selected ?? allIds)
    if (s.has(id)) s.delete(id); else s.add(id)
    set(s)
  }
  // "Todos"/"Nenhum" respeitam a busca: agem só sobre os itens visíveis
  const selectVisible = (on: boolean) => {
    const s = new Set(selected ?? allIds)
    visible.forEach(t => on ? s.add(t.id) : s.delete(t.id))
    set(s)
  }
  const withCritical = items.filter(t => t.critical > 0)
  const all = feminine ? 'Todas' : 'Todos'
  const none = feminine ? 'Nenhuma' : 'Nenhum'

  const label = selected === null ? `${all} ${feminine ? 'as' : 'os'} ${plural}` : count === 0 ? `${none} ${singular}` : count === 1
    ? items.find(t => selected.has(t.id))?.name ?? `1 ${singular}` : `${count} de ${items.length} ${plural}`

  return (
    <div className="tf" ref={root}>
      <button type="button" className={`tf-btn${selected !== null ? ' active' : ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="dialog">
        <span className="tf-icon" aria-hidden>{icon}</span>
        <span className="tf-label">{label}</span>
        <span className="chev" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {selected !== null && (
        <button type="button" className="tf-clear" title={`Mostrar ${all.toLowerCase()} ${feminine ? 'as' : 'os'} ${plural}`} aria-label={`Limpar filtro de ${plural}`} onClick={() => onChange(null)}>×</button>
      )}

      {open && (
        <div className="tf-pop" role="dialog" aria-label={`Filtrar ${plural}`}>
          <input ref={search} type="search" className="tf-search" placeholder={`Buscar ${singular}…`} value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && visible.length === 1) toggle(visible[0]!.id) }} />
          <div className="tf-quick">
            <button type="button" onClick={() => selectVisible(true)}>{q ? 'Marcar visíveis' : all}</button>
            <button type="button" onClick={() => selectVisible(false)}>{q ? 'Desmarcar visíveis' : none}</button>
            <button type="button" onClick={() => set(withCritical.map(t => t.id))} disabled={withCritical.length === 0}
              title="Só itens com tickets acima do limite crítico de tempo aberto">Com críticos ({withCritical.length})</button>
          </div>
          <div className="tf-head"><span>{singular}</span><span title="Em aberto · Bloqueados · Completos">Aber. · Bloq. · Compl.</span></div>
          <ul className="tf-list">
            {visible.map(t => (
              <li key={String(t.id)} className={`${isOn(t.id) ? 'on' : ''}${t.special ? ' special' : ''}`}>
                <label>
                  <input type="checkbox" checked={isOn(t.id)} onChange={() => toggle(t.id)} />
                  <span className={`tf-name${t.special ? ' muted' : ''}`} title={t.title ?? t.name}>{t.name}</span>
                  {t.critical > 0 && <span className="pill crit" title={`${t.critical} ticket(s) em aberto acima do limite crítico`}>{t.critical}</span>}
                  <span className="tf-nums">
                    <b className="n-blue">{t.open}</b>·<b className="n-red">{t.blocked}</b>·<b className="n-green">{t.done}</b>
                  </span>
                </label>
                <button type="button" className="tf-only" onClick={() => set([t.id])} title={`Mostrar só ${t.name}`}>só</button>
              </li>
            ))}
            {visible.length === 0 && <li className="empty">{none} {singular} encontrad{feminine ? 'a' : 'o'}.</li>}
          </ul>
          <div className="tf-foot">
            <span className="muted">{count} de {items.length} selecionad{feminine ? 'a' : 'o'}(s)</span>
            <button type="button" className="primary" onClick={() => setOpen(false)}>Pronto</button>
          </div>
        </div>
      )}
    </div>
  )
}

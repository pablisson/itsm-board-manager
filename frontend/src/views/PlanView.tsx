import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BoardSnapshot, BoardTicket } from '../types'
import { apiUrl } from '../format'
import { placedTickets, type BoardColumnKey } from '../entity'

interface PlanItem { id: number; techId: number; techName: string | null; ticketId: number; title: string | null; day: string; position: number }
interface PlanCount { techId: number; ticketId: number; days: number; next: string }
interface PlanResponse { month: string; from: string; to: string; today: string; items: PlanItem[]; counts: PlanCount[] }

/** O que está sendo arrastado: um ticket do backlog (novo planejamento) ou um item já planejado (mover). */
type Drag = { techId: number; ticketId: number; title: string; itemId?: number; fromDay?: string }

const OPEN = new Set<BoardColumnKey>(['inProgress', 'blocked', 'unassigned'])
const pad = (n: number) => String(n).padStart(2, '0')
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const monthOf = (iso: string) => iso.slice(0, 7)
const shiftMonth = (m: string, delta: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y!, mo! - 1 + delta, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }

const daysOf = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  const n = new Date(y!, mo!, 0).getDate()
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y!, mo! - 1, i + 1)
    return { iso: `${m}-${pad(i + 1)}`, day: i + 1, wd: d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''), weekend: d.getDay() === 0 || d.getDay() === 6 }
  })
}
const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { credentials: 'same-origin', ...init, headers: init?.body ? { 'Content-Type': 'application/json' } : undefined })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
  return body as T
}

export default function PlanView({ snap, techIds, match }: {
  snap: BoardSnapshot
  /** técnicos selecionados no filtro do topo (null = todos) */
  techIds: Set<number> | null
  /** filtro de texto/entidade do topo */
  match: (t: BoardTicket) => boolean
}) {
  const [month, setMonth] = useState(() => monthOf(localToday()))
  const [data, setData] = useState<PlanResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<string | null>(null) // célula sob o cursor: `${techId}|${day|backlog}`
  const scroller = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const today = localToday()
  const days = useMemo(() => daysOf(month), [month])

  const load = useCallback(async (m: string, silent = false) => {
    if (!silent) setBusy(true)
    try { setData(await api<PlanResponse>(`/api/plan?month=${m}`)); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { if (!silent) setBusy(false) }
  }, [])
  useEffect(() => { void load(month) }, [month, load])
  // outras pessoas podem estar planejando: recarrega a cada 60s (sem atrapalhar um arraste)
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !dragRef.current) void load(month, true) }, 60_000)
    return () => clearInterval(t)
  }, [month, load])

  // rolagem horizontal posicionada no dia corrente (ou no início do mês)
  const scrolledFor = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !data || data.month !== month || scrolledFor.current === month) return
    scrolledFor.current = month
    const th = el.querySelector<HTMLElement>(`th[data-day="${today}"]`)
    const sticky = (el.querySelector<HTMLElement>('th.pl-tech')?.offsetWidth ?? 0) + (el.querySelector<HTMLElement>('th.pl-backlog')?.offsetWidth ?? 0)
    // posição real na tela (offsetLeft é relativo a outro ancestral e erra o cálculo)
    el.scrollLeft = th ? Math.max(0, el.scrollLeft + th.getBoundingClientRect().left - el.getBoundingClientRect().left - sticky - 8) : 0
  }, [data, month, today])

  // ---------- dados ----------
  const tickets = useMemo(() => new Map(placedTickets(snap).map(p => [p.ticket.id, p])), [snap])
  const counts = useMemo(() => new Map((data?.counts ?? []).map(c => [`${c.techId}|${c.ticketId}`, c])), [data])

  const rows = useMemo(() => {
    const techs = new Map<number, { id: number; name: string; backlog: BoardTicket[] }>()
    for (const { ticket, column } of tickets.values()) {
      if (!OPEN.has(column)) continue
      for (const tech of ticket.technicians) {
        if (!techs.has(tech.id)) techs.set(tech.id, { id: tech.id, name: tech.name, backlog: [] })
        techs.get(tech.id)!.backlog.push(ticket)
      }
    }
    // técnicos que só têm itens planejados no mês (ex.: tickets já fechados)
    for (const it of data?.items ?? []) if (!techs.has(it.techId)) techs.set(it.techId, { id: it.techId, name: it.techName ?? `Técnico #${it.techId}`, backlog: [] })
    const byCell = new Map<string, PlanItem[]>()
    for (const it of data?.items ?? []) { const k = `${it.techId}|${it.day}`; (byCell.get(k) ?? byCell.set(k, []).get(k)!).push(it) }
    const itemMatch = (it: PlanItem) => { const t = tickets.get(it.ticketId)?.ticket; return t ? match(t) : match({ id: it.ticketId, title: it.title ?? '', technicians: [], assignedGroups: [] } as unknown as BoardTicket) }
    return [...techs.values()]
      .filter(r => techIds === null || techIds.has(r.id))
      .map(r => ({
        ...r,
        backlog: r.backlog.filter(match).sort((a, b) => (a.openedAtUtc ?? '').localeCompare(b.openedAtUtc ?? '')),
        cells: new Map(days.map(d => [d.iso, (byCell.get(`${r.id}|${d.iso}`) ?? []).filter(itemMatch)])),
      }))
      .filter(r => r.backlog.length > 0 || [...r.cells.values()].some(c => c.length > 0))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  }, [tickets, data, days, techIds, match])

  const plannedTotal = data?.items.length ?? 0

  // ---------- mutações (otimistas, com rollback) ----------
  const mutate = async (optimistic: (items: PlanItem[]) => PlanItem[], call: () => Promise<unknown>) => {
    if (!data) return
    const before = data
    setData({ ...data, items: optimistic(data.items) })
    try { await call(); await load(month, true) }
    catch (e) { setData(before); setError(`Não foi possível salvar: ${e instanceof Error ? e.message : String(e)}`) }
  }
  const techName = (id: number) => rows.find(r => r.id === id)?.name ?? null
  const plan = (d: Drag, day: string) => mutate(
    items => [...items, { id: -Date.now(), techId: d.techId, techName: techName(d.techId), ticketId: d.ticketId, title: d.title, day, position: 9999 }],
    () => api('/api/plan', { method: 'POST', body: JSON.stringify({ techId: d.techId, techName: techName(d.techId), ticketId: d.ticketId, title: d.title, day }) }))
  const move = (d: Drag, day: string) => mutate(
    items => items.map(i => i.id === d.itemId ? { ...i, day, position: 9999 } : i),
    () => api(`/api/plan/${d.itemId}`, { method: 'PUT', body: JSON.stringify({ day }) }))
  const remove = (id: number) => mutate(items => items.filter(i => i.id !== id), () => api(`/api/plan/${id}`, { method: 'DELETE' }))

  // ---------- arrastar e soltar ----------
  const start = (e: React.DragEvent, d: Drag) => {
    dragRef.current = d; setDrag(d)
    e.dataTransfer.effectAllowed = d.itemId ? 'copyMove' : 'copy'
    e.dataTransfer.setData('text/plain', `#${d.ticketId} ${d.title}`)
  }
  const end = () => { dragRef.current = null; setDrag(null); setOver(null) }
  const allow = (techId: number, key: string) => (e: React.DragEvent) => {
    const d = dragRef.current
    if (!d || d.techId !== techId) return // só na linha do próprio técnico
    if (key === 'backlog' && !d.itemId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = key === 'backlog' ? 'move' : d.itemId && !(e.ctrlKey || e.metaKey) ? 'move' : 'copy'
    const k = `${techId}|${key}`
    if (over !== k) setOver(k)
  }
  const drop = (techId: number, key: string) => (e: React.DragEvent) => {
    e.preventDefault()
    const d = dragRef.current
    end()
    if (!d || d.techId !== techId) return
    if (key === 'backlog') { if (d.itemId) void remove(d.itemId); return }
    if (d.itemId && !(e.ctrlKey || e.metaKey)) { if (d.fromDay !== key) void move(d, key) } // mover
    else void plan(d, key) // do backlog, ou Ctrl+arrastar = copiar para outro dia
  }

  const stateOf = (ticketId: number) => {
    const p = tickets.get(ticketId)
    if (!p) return 'gone'
    return p.column === 'completed' || p.column === 'cancelled' ? 'done' : p.column === 'blocked' ? 'blocked' : 'open'
  }

  return (
    <section className="plan">
      <div className="plan-bar">
        <div className="plan-month">
          <button type="button" onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label="Mês anterior">‹</button>
          <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} aria-label="Mês" />
          <button type="button" onClick={() => setMonth(m => shiftMonth(m, 1))} aria-label="Próximo mês">›</button>
          {month !== monthOf(today) && <button type="button" className="link" onClick={() => { scrolledFor.current = null; setMonth(monthOf(today)) }}>Ir para hoje</button>}
        </div>
        <p className="plan-hint">
          Arraste um ticket da 2ª coluna para um dia. Entre dias: arraste para mover · <kbd>Ctrl</kbd>+arrastar para copiar · de volta ao backlog (ou ×) para desplanejar.
        </p>
        <span className="plan-stats">{busy ? 'carregando…' : `${plannedTotal} planejamento(s) no mês`}</span>
      </div>

      {error && <div className="banner error">{error} <button type="button" className="link" onClick={() => void load(month)}>Tentar novamente</button></div>}

      <div className={`plan-scroll${drag ? ' dragging' : ''}`} ref={scroller}>
        <table className="plan-grid">
          <thead>
            <tr>
              <th className="pl-tech pl-sticky">Técnico</th>
              <th className="pl-backlog pl-sticky">Tickets atribuídos</th>
              {days.map(d => (
                <th key={d.iso} data-day={d.iso} className={`pl-day${d.weekend ? ' we' : ''}${d.iso === today ? ' today' : ''}`}>
                  <span>{d.wd}</span><b>{d.day}</b>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td className="pl-empty" colSpan={days.length + 2}>Nenhum técnico com tickets para os filtros atuais.</td></tr>}
            {rows.map(r => {
              const dimRow = drag && drag.techId !== r.id
              return (
                <tr key={r.id} className={dimRow ? 'dim' : ''}>
                  <th scope="row" className="pl-tech pl-sticky">
                    <span className="pl-name">{r.name}</span>
                    <span className="pl-sub">{r.backlog.length} aberto(s)</span>
                  </th>
                  <td className={`pl-backlog pl-sticky${over === `${r.id}|backlog` ? ' over' : ''}`}
                    onDragOver={allow(r.id, 'backlog')} onDragLeave={() => setOver(null)} onDrop={drop(r.id, 'backlog')}>
                    <div className="pl-backlog-list">
                      {r.backlog.map(t => {
                        const c = counts.get(`${r.id}|${t.id}`)
                        return (
                          <div key={t.id} className={`pl-card${c ? ' planned' : ''}${t.status === 4 ? ' blocked' : ''}`} draggable
                            onDragStart={e => start(e, { techId: r.id, ticketId: t.id, title: t.title })} onDragEnd={end}
                            title={`#${t.id} ${t.title}${t.status === 4 ? '\n(Pendente)' : ''}${c ? `\nPlanejado em ${c.days} dia(s) · próximo: ${shortDate(c.next)}` : '\nAinda não planejado'}`}>
                            <a href={t.url} target="_blank" rel="noopener noreferrer" className="id" draggable={false}>#{t.id}</a>
                            {c && <span className="pl-when" aria-label={`planejado, próximo ${shortDate(c.next)}`}>{shortDate(c.next)}</span>}
                            <span className="pl-title">{t.title}</span>
                          </div>
                        )
                      })}
                      {r.backlog.length === 0 && <span className="pl-none">—</span>}
                    </div>
                  </td>
                  {days.map(d => {
                    const items = r.cells.get(d.iso) ?? []
                    const key = `${r.id}|${d.iso}`
                    return (
                      <td key={d.iso} className={`pl-cell${d.weekend ? ' we' : ''}${d.iso === today ? ' today' : ''}${d.iso < today ? ' past' : ''}${over === key ? ' over' : ''}`}
                        onDragOver={allow(r.id, d.iso)} onDragLeave={() => setOver(o => (o === key ? null : o))} onDrop={drop(r.id, d.iso)}>
                        {items.map(it => {
                          const st = stateOf(it.ticketId)
                          const t = tickets.get(it.ticketId)?.ticket
                          const title = t?.title ?? it.title ?? ''
                          return (
                            <div key={it.id} className={`pl-card in-day ${st}${it.id < 0 ? ' saving' : ''}`} draggable={it.id > 0}
                              onDragStart={e => start(e, { techId: r.id, ticketId: it.ticketId, title, itemId: it.id, fromDay: it.day })} onDragEnd={end}
                              title={`#${it.ticketId} ${title}${st === 'done' ? '\n(solucionado/fechado)' : st === 'blocked' ? '\n(Pendente)' : st === 'gone' ? '\n(fora do board atual)' : ''}`}>
                              {t ? <a href={t.url} target="_blank" rel="noopener noreferrer" className="id" draggable={false}>#{it.ticketId}</a> : <span className="id">#{it.ticketId}</span>}
                              {st === 'done' && <span className="pl-done" aria-label="concluído">✓</span>}
                              <button type="button" className="pl-x" title="Remover deste dia" aria-label={`Remover #${it.ticketId} de ${shortDate(d.iso)}`} onClick={() => void remove(it.id)}>×</button>
                              <span className="pl-title">{title}</span>
                            </div>
                          )
                        })}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

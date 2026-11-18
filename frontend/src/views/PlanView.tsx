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
const weekday = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')
const monthName = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

interface CopyGroup { tech: string; items: { id: number; title: string; url: string | null; added?: boolean; status?: string }[] }
interface SolvedImport {
  from: string; to: string; tickets: number; added: number; existing: number
  items: { day: string; techId: number; techName: string; ticketId: number; title: string; url: string; status: number; statusLabel: string; entity: string | null; added: boolean }[]
  withoutTechnician: { ticketId: number; title: string; url: string; day: string }[]
  warnings: string[]
}
interface CopySection { day: string; groups: CopyGroup[] }

/** texto puro + HTML (links clicáveis ao colar no Teams/Outlook) das tarefas, por dia e técnico */
function buildCopy(sections: CopySection[], mode: 'day' | 'month') {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const total = sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.items.length, 0), 0)
  const techs = new Set(sections.flatMap(s => s.groups.map(g => g.tech))).size
  const first = sections[0]?.day ?? ''
  const head = mode === 'day'
    ? `Planejamento de ${weekday(first)} ${shortDate(first)}/${first.slice(0, 4)} — ${total} tarefa(s)`
    : `Planejamento de ${monthName(first.slice(0, 7))} — ${total} tarefa(s) em ${sections.length} dia(s)`
  const line = (g: CopyGroup, i: CopyGroup['items'][number]) => `• #${i.id} — ${i.title} — Técnico: ${g.tech}${i.url ? ` — ${i.url}` : ''}`
  const lineHtml = (g: CopyGroup, i: CopyGroup['items'][number]) =>
    `<li>${i.url ? `<a href="${esc(i.url)}">#${i.id}</a>` : `#${i.id}`} — ${esc(i.title)} — Técnico: ${esc(g.tech)}${i.url ? ` — <a href="${esc(i.url)}">${esc(i.url)}</a>` : ''}</li>`
  const text = [head, '', ...sections.flatMap(s => [
    ...(mode === 'month' ? [`=== ${weekday(s.day)} ${shortDate(s.day)} ===`] : []),
    ...s.groups.flatMap(g => [`${g.tech} (${g.items.length})`, ...g.items.map(i => line(g, i)), '']),
  ])].join('\n').trimEnd()
  const html = `<p><b>${esc(head)}</b></p>` + sections.map(s =>
    (mode === 'month' ? `<h3>${esc(`${weekday(s.day)} ${shortDate(s.day)}`)}</h3>` : '') +
    s.groups.map(g => `<p><b>${esc(g.tech)}</b> (${g.items.length})</p><ul>${g.items.map(i => lineHtml(g, i)).join('')}</ul>`).join('')).join('')
  return { text, html, total, techs }
}

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

  // ---------- copiar as tarefas de um dia (por técnico) ----------
  const [copied, setCopied] = useState<{ day: string; text: string } | null>(null)
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(null), 3500); return () => clearTimeout(t) }, [copied])
  // URL do ticket no ITSM: a do board, ou montada a partir da base de qualquer ticket conhecido
  const ticketUrl = useMemo(() => {
    const sample = [...tickets.values()].find(p => p.ticket.url)?.ticket.url
    return (id: number) => tickets.get(id)?.ticket.url ?? (sample ? sample.replace(/([?&]id=)\d+/, `$1${id}`) : null)
  }, [tickets])
  // itens visíveis com os filtros do topo (técnicos + texto/entidade)
  const visible = useCallback((it: PlanItem) => {
    if (techIds !== null && !techIds.has(it.techId)) return false
    const t = tickets.get(it.ticketId)?.ticket
    return t ? match(t) : match({ id: it.ticketId, title: it.title ?? '', technicians: [], assignedGroups: [] } as unknown as BoardTicket)
  }, [techIds, tickets, match])
  const knownTech = useMemo(() => new Map(rows.map(r => [r.id, r.name])), [rows])
  /** agrupa por técnico (ordem alfabética) */
  const toGroups = useCallback((items: PlanItem[]): CopyGroup[] => {
    const by = new Map<number, CopyGroup>()
    for (const it of [...items].sort((a, b) => a.position - b.position)) {
      const tech = it.techName ?? knownTech.get(it.techId) ?? `Técnico #${it.techId}`
      const g = by.get(it.techId) ?? by.set(it.techId, { tech, items: [] }).get(it.techId)!
      g.items.push({ id: it.ticketId, title: tickets.get(it.ticketId)?.ticket.title ?? it.title ?? '', url: ticketUrl(it.ticketId) })
    }
    return [...by.values()].sort((a, b) => a.tech.localeCompare(b.tech, 'pt-BR'))
  }, [knownTech, tickets, ticketUrl])
  /** seções por dia (ordem cronológica) */
  const toSections = useCallback((items: PlanItem[]): CopySection[] => {
    const byDay = new Map<string, PlanItem[]>()
    for (const it of items) (byDay.get(it.day) ?? byDay.set(it.day, []).get(it.day)!).push(it)
    return [...byDay.keys()].sort().map(day => ({ day, groups: toGroups(byDay.get(day)!) }))
  }, [toGroups])

  const copyDay = async (day: string) => {
    const sections = toSections((data?.items ?? []).filter(it => it.day === day && visible(it)))
    if (sections.length === 0) return
    const r = await copySections(sections, 'day')
    if (r) setCopied({ day, text: `${r.total} tarefa(s) de ${r.techs} técnico(s) em ${shortDate(day)} copiada(s)` })
  }
  const copySections = async (sections: CopySection[], mode: 'day' | 'month') => {
    const { text, html, total, techs } = buildCopy(sections, mode)
    try {
      if (window.isSecureContext && navigator.clipboard) {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })])
        } else await navigator.clipboard.writeText(text)
      } else {
        // fallback para http fora de localhost (Clipboard API indisponível)
        const ta = document.createElement('textarea')
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select()
        const ok = document.execCommand('copy'); ta.remove()
        if (!ok) throw new Error('o navegador bloqueou a cópia')
      }
      return { total, techs }
    } catch (e) {
      setError(`Não foi possível copiar: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  // ---------- buscar no ITSM os solucionados/fechados de um dia ou mês e colocar no planejamento ----------
  const [findMode, setFindMode] = useState<'day' | 'month'>('day')
  const [findDay, setFindDay] = useState(today)
  const [findMonth, setFindMonth] = useState(() => monthOf(today))
  const [found, setFound] = useState<{ mode: 'day' | 'month'; key: string; sections: CopySection[]; res: SolvedImport } | null>(null)
  const [finding, setFinding] = useState(false)
  const [foundCopied, setFoundCopied] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const findRef = useRef<HTMLDivElement>(null)
  // fecha a caixa ao clicar fora ou com Esc
  useEffect(() => {
    if (!findOpen) return
    const onDown = (e: MouseEvent) => { if (!findRef.current?.contains(e.target as Node)) setFindOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFindOpen(false) }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [findOpen])
  const search = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setFindOpen(false)
    const key = findMode === 'day' ? findDay : findMonth
    if (!key) return
    const m = monthOf(key)
    const from = findMode === 'day' ? key : `${m}-01`
    const to = findMode === 'day' ? key : `${m}-${pad(daysOf(m).length)}`
    setFinding(true); setFoundCopied(false)
    try {
      const r = await fetch(apiUrl('/api/plan/import-solved'), {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'board' },
        body: JSON.stringify({ from, to }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${r.status}`)
      const res = body as SolvedImport
      // agrupa por dia e técnico
      const byDay = new Map<string, Map<string, CopyGroup>>()
      for (const it of res.items) {
        const techs = byDay.get(it.day) ?? byDay.set(it.day, new Map()).get(it.day)!
        const g = techs.get(it.techName) ?? techs.set(it.techName, { tech: it.techName, items: [] }).get(it.techName)!
        g.items.push({ id: it.ticketId, title: it.title, url: it.url, added: it.added, status: it.statusLabel })
      }
      const sections = [...byDay.keys()].sort().map(day => ({ day, groups: [...byDay.get(day)!.values()].sort((a, b) => a.tech.localeCompare(b.tech, 'pt-BR')) }))
      setFound({ mode: findMode, key, sections, res })
      setError(null)
      // mostra os itens na grade: vai para o mês buscado (ou recarrega o atual)
      if (m === month) await load(month, true)
      else { scrolledFor.current = null; setMonth(m) }
    } catch (err) { setError(`Não foi possível buscar no ITSM: ${err instanceof Error ? err.message : String(err)}`) }
    finally { setFinding(false) }
  }
  const foundTotal = found ? found.sections.reduce((n, s) => n + s.groups.reduce((m, g) => m + g.items.length, 0), 0) : 0
  const foundTitle = found ? (found.mode === 'day' ? `${weekday(found.key)} ${shortDate(found.key)}/${found.key.slice(0, 4)}` : monthName(found.key)) : ''

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
          <div className="pl-find-wrap" ref={findRef}>
            <button type="button" className={`pl-find-btn${findOpen ? ' on' : ''}`} aria-expanded={findOpen} aria-haspopup="dialog"
              title="Buscar no ITSM os tickets solucionados/fechados e colocar no planejamento" onClick={() => setFindOpen(o => !o)}>
              {finding ? '⏳' : '✓'} Solucionados no ITSM <span aria-hidden>▾</span>
            </button>
            {findOpen && (
              <form className="pl-find" role="dialog" aria-label="Solucionados/fechados no ITSM" onSubmit={e => void search(e)}>
                <span className="pl-find-label">Solucionados/fechados no ITSM</span>
                <div className="pl-find-row">
                  <div className="pl-seg" role="radiogroup" aria-label="Período">
                    <button type="button" role="radio" aria-checked={findMode === 'day'} className={findMode === 'day' ? 'on' : ''} onClick={() => setFindMode('day')}>Dia</button>
                    <button type="button" role="radio" aria-checked={findMode === 'month'} className={findMode === 'month' ? 'on' : ''} onClick={() => setFindMode('month')}>Mês</button>
                  </div>
                  {findMode === 'day'
                    ? <input type="date" value={findDay} onChange={e => setFindDay(e.target.value)} aria-label="Dia" required autoFocus />
                    : <input type="month" value={findMonth} onChange={e => setFindMonth(e.target.value)} aria-label="Mês" required autoFocus />}
                </div>
                <button type="submit" className="primary" disabled={finding}>{finding ? 'Buscando no ITSM…' : '🔍 Buscar e planejar'}</button>
                <span className="pl-find-note">Cada ticket entra no dia em que foi solucionado, na linha de cada técnico atribuído.</span>
              </form>
            )}
          </div>
        </div>
        <p className="plan-hint">
          Arraste um ticket da 2ª coluna para um dia. Entre dias: arraste para mover · <kbd>Ctrl</kbd>+arrastar para copiar · de volta ao backlog (ou ×) para desplanejar.
        </p>
        <span className="plan-stats" role="status">{copied ? <span className="pl-copied">✓ {copied.text}</span> : busy ? 'carregando…' : `${plannedTotal} planejamento(s) no mês`}</span>
      </div>

      {found && (
        <section className="pl-found" aria-label="Itens encontrados">
          <header>
            <h3>Solucionados/fechados · {foundTitle} <small>
              {found.res.tickets} ticket(s) no ITSM · <b className="pl-new">{found.res.added} adicionado(s) ao planejamento</b>{found.res.existing > 0 && ` · ${found.res.existing} já estava(m)`}
              {found.mode === 'month' && ` · ${found.sections.length} dia(s)`}
            </small></h3>
            <div className="pl-found-actions">
              <button type="button" className={foundCopied ? 'ok' : ''} disabled={foundTotal === 0}
                onClick={async () => { if (await copySections(found.sections, found.mode)) setFoundCopied(true) }}>
                {foundCopied ? '✓ Copiado' : '⧉ Copiar tudo'}
              </button>
              <button type="button" className="pl-x-btn" aria-label="Fechar" onClick={() => setFound(null)}>×</button>
            </div>
          </header>
          {foundTotal === 0 && <p className="pl-none">Nenhum ticket com técnico foi solucionado ou fechado {found.mode === 'day' ? 'neste dia' : 'neste mês'} no ITSM.</p>}
          {found.res.withoutTechnician.length > 0 && (
            <p className="pl-found-warn">⚠ {found.res.withoutTechnician.length} ticket(s) sem técnico atribuído não entraram no planejamento:{' '}
              {found.res.withoutTechnician.map((t, i) => <span key={t.ticketId}>{i > 0 && ', '}<a href={t.url} target="_blank" rel="noopener noreferrer" title={t.title}>#{t.ticketId}</a></span>)}
            </p>
          )}
          {found.res.warnings.length > 0 && <p className="pl-found-warn">⚠ {found.res.warnings.join(' · ')}</p>}
          <div className="pl-found-body">
            {found.sections.map(s => (
              <div key={s.day} className="pl-found-day">
                {found.mode === 'month' && (
                  <h4>{weekday(s.day)} {shortDate(s.day)}
                    <button type="button" className="link" onClick={() => void copySections([s], 'day').then(r => r && setCopied({ day: s.day, text: `${r.total} tarefa(s) de ${r.techs} técnico(s) em ${shortDate(s.day)} copiada(s)` }))}>copiar dia</button>
                  </h4>
                )}
                {s.groups.map(g => (
                  <div key={g.tech} className="pl-found-tech">
                    <b>{g.tech}</b> <span className="pl-found-n">({g.items.length})</span>
                    <ul>{g.items.map(i => (
                      <li key={i.id}>
                        {i.url ? <a href={i.url} target="_blank" rel="noopener noreferrer">#{i.id}</a> : <span>#{i.id}</span>} {i.title}
                        {i.status && <span className="pl-found-st">{i.status}</span>}
                        {i.added === true && <span className="pl-tag new">novo</span>}
                        {i.added === false && <span className="pl-tag">já estava</span>}
                      </li>
                    ))}</ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {error && <div className="banner error">{error} <button type="button" className="link" onClick={() => void load(month)}>Tentar novamente</button></div>}

      <div className={`plan-scroll${drag ? ' dragging' : ''}`} ref={scroller}>
        <table className="plan-grid">
          <thead>
            <tr>
              <th className="pl-tech pl-sticky">Técnico</th>
              <th className="pl-backlog pl-sticky">Tickets atribuídos</th>
              {days.map(d => {
                const n = rows.reduce((s, r) => s + (r.cells.get(d.iso)?.length ?? 0), 0)
                return (
                  <th key={d.iso} data-day={d.iso} className={`pl-day${d.weekend ? ' we' : ''}${d.iso === today ? ' today' : ''}`}>
                    <span>{d.wd}</span><b>{d.day}</b>
                    <button type="button" className={`pl-copy${copied?.day === d.iso ? ' ok' : ''}`} disabled={n === 0}
                      title={n ? `Copiar as ${n} tarefa(s) do dia ${shortDate(d.iso)} por técnico (link, título, ID e técnico)` : 'Nenhuma tarefa neste dia'}
                      aria-label={`Copiar tarefas de ${shortDate(d.iso)}`} onClick={() => void copyDay(d.iso)}>
                      {copied?.day === d.iso ? '✓' : '⧉'}{n > 0 && <small>{n}</small>}
                    </button>
                  </th>
                )
              })}
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

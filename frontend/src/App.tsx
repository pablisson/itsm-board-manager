import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardResponse, BoardTicket, TechnicianLane } from './types'
import { apiUrl, formatDate, formatDuration, hoursBetween } from './format'
import { entityKey, placedTickets, shortEntity } from './entity'
import EntitiesView from './views/EntitiesView'
import MonthlyReportView from './views/MonthlyReportView'
import TimelineView from './views/TimelineView'
import MultiFilter, { type FilterItem, type FilterKey } from './components/MultiFilter'
import type { BoardSnapshot } from './types'
import { SLA_FILTERS, slaFilterMatch, slaInfo, type SlaFilter, type SlaPart } from './sla'

function usePersistedSla(): [SlaFilter, (f: SlaFilter) => void] {
  const [f, setF] = useState<SlaFilter>(() => {
    try { const v = localStorage.getItem('board.sla'); return SLA_FILTERS.some(x => x.id === v) ? v as SlaFilter : 'all' } catch { return 'all' }
  })
  return [f, (v: SlaFilter) => { setF(v); try { localStorage.setItem('board.sla', v) } catch { /* sem storage */ } }]
}

/** Id reservado para "Sem técnico" (tickets sem técnico atribuído). */
const NO_TECH = -1

// Seleções lembradas neste navegador (null = todos)
function loadSel<K extends FilterKey>(key: string): Set<K> | null {
  try { const v = localStorage.getItem(key); return v ? new Set(JSON.parse(v) as K[]) : null } catch { return null }
}
function saveSel<K extends FilterKey>(key: string, s: Set<K> | null) {
  try { if (s === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify([...s])) } catch { /* sem storage */ }
}
function usePersistedSel<K extends FilterKey>(key: string): [Set<K> | null, (s: Set<K> | null) => void] {
  const [sel, setSel] = useState<Set<K> | null>(() => loadSel<K>(key))
  return [sel, (s: Set<K> | null) => { setSel(s); saveSel(key, s) }]
}

/** Carga por item (técnico/entidade): em aberto, bloqueados, completos e críticos. */
function buildStats<K extends FilterKey>(snap: BoardSnapshot, now: Date, keysOf: (t: BoardTicket) => { id: K; name: string; title?: string; special?: boolean }[]): FilterItem<K>[] {
  const m = new Map<K, FilterItem<K>>()
  for (const { ticket: t, column } of placedTickets(snap)) {
    for (const k of keysOf(t)) {
      let s = m.get(k.id)
      if (!s) m.set(k.id, s = { ...k, open: 0, blocked: 0, done: 0, critical: 0 })
      if (column === 'inProgress' || column === 'unassigned') {
        s.open++
        if ((hoursBetween(t.openedAtUtc, now) ?? 0) >= snap.ageCriticalHours) s.critical++
      } else if (column === 'blocked') s.blocked++
      else if (column === 'completed') s.done++
    }
  }
  return [...m.values()].sort((a, b) => Number(!!b.special) - Number(!!a.special) || b.open - a.open || b.blocked - a.blocked || a.name.localeCompare(b.name))
}

type Thresholds = { warn: number; crit: number }
type Tab = 'board' | 'entidades' | 'timeline' | 'relatorio'
const TABS: { id: Tab; label: string }[] = [
  { id: 'board', label: 'Board' }, { id: 'entidades', label: 'Entidades' }, { id: 'timeline', label: 'Linha do tempo' }, { id: 'relatorio', label: 'Relatório mensal' },
]
const readTab = (): Tab => { const h = location.hash.replace('#', ''); return TABS.some(t => t.id === h) ? h as Tab : 'board' }

function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(readTab)
  useEffect(() => { const f = () => setTab(readTab()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f) }, [])
  return [tab, (t: Tab) => { location.hash = t; setTab(t) }]
}

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), intervalMs); return () => clearInterval(t) }, [intervalMs])
  return now
}

export default function App() {
  const [data, setData] = useState<BoardResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [entitySel, setEntitySel] = usePersistedSel<string>('board.entities')
  const [techSel, setTechSel] = usePersistedSel<number>('board.techs')
  const [slaFilter, setSlaFilter] = usePersistedSla()
  const [tab, setTab] = useTab()
  const now = useNow()

  const load = useCallback(async (force: boolean, silent = false) => {
    if (!silent) { setLoading(true); setRequestError(null); setNotice(null) }
    try {
      const res = await fetch(apiUrl(force ? '/api/board/refresh' : '/api/board'), { method: force ? 'POST' : 'GET', credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
      const r = body as BoardResponse
      setData(r)
      if (r.throttledSeconds) setNotice(`Ressincronização limitada a 1 a cada ${r.throttledSeconds}s — exibindo a última leitura.`)
      if (silent) setRequestError(null)
    } catch (e) {
      if (!silent) setRequestError(e instanceof Error ? e.message : String(e))
    } finally { if (!silent) setLoading(false) }
  }, [])

  useEffect(() => { void load(false) }, [load])
  // Atualização automática silenciosa: pega o snapshot que o servidor renovou em segundo plano
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(false, true) }, 120_000)
    return () => clearInterval(t)
  }, [load])

  const snap = data?.snapshot ?? null
  const th: Thresholds = { warn: snap?.ageWarnHours ?? 72, crit: snap?.ageCriticalHours ?? 168 }

  // filtro de texto (todas as abas do board)
  const textMatch = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return () => true
    return (t: BoardTicket) =>
      `#${t.id} ${t.title} ${t.category ?? ''} ${t.entity ?? ''} ${t.technicians.map(x => x.name).join(' ')} ${t.assignedGroups.join(' ')}`
        .toLowerCase().includes(q)
  }, [filter])
  const entityMatch = useMemo(() => (t: BoardTicket) => entitySel === null || entitySel.has(entityKey(t)), [entitySel])
  // texto + entidades + técnicos selecionados + SLA (Board)
  const match = useMemo(() => (t: BoardTicket) =>
    textMatch(t) && entityMatch(t) &&
    (techSel === null || (t.technicians.length ? t.technicians.some(x => techSel.has(x.id)) : techSel.has(NO_TECH))) &&
    slaFilterMatch(slaFilter, slaInfo(t, now)),
  [textMatch, entityMatch, techSel, slaFilter, now])

  const techStats = useMemo(() => snap ? buildStats<number>(snap, now, t =>
    t.technicians.length ? t.technicians.map(x => ({ id: x.id, name: x.name })) : [{ id: NO_TECH, name: 'Sem técnico', special: true }]) : [], [snap, now])

  const entityStats = useMemo(() => snap ? buildStats<string>(snap, now, t =>
    [{ id: entityKey(t), name: shortEntity(t.entity), title: t.entity ?? undefined }]) : [], [snap, now])

  const countSel = <K extends FilterKey>(items: FilterItem<K>[], s: Set<K>) => items.filter(i => s.has(i.id)).length
  const clearAll = () => { setFilter(''); setEntitySel(null); setTechSel(null); setSlaFilter('all') }

  const cols = snap?.columns
  const filtering = !!filter || entitySel !== null || techSel !== null || slaFilter !== 'all'
  const lanes = (cols?.inProgress ?? [])
    .filter(l => techSel === null || techSel.has(l.id))
    .map(l => ({ ...l, tickets: l.tickets.filter(match) }))
    .filter(l => l.tickets.length > 0 || !filtering)
  const fUnassigned = (cols?.unassigned ?? []).filter(match)
  const fBlocked = (cols?.blocked ?? []).filter(match)
  const fCompleted = (cols?.completed ?? []).filter(match)
  const fCancelled = (cols?.cancelled ?? []).filter(match)
  const fInProgress = new Set(lanes.flatMap(l => l.tickets.map(t => t.id))).size

  // SLA dos chamados em aberto exibidos (sem duplicar tickets com mais de um técnico)
  const openShown = [...new Map([...fUnassigned, ...lanes.flatMap(l => l.tickets), ...fBlocked].map(t => [t.id, t])).values()]
  const openSla = openShown.map(t => slaInfo(t, now))
  const slaLate = openSla.filter(i => i.tto?.state === 'late' || i.ttr?.state === 'late').length
  const slaWarn = openSla.filter(i => i.worst === 'warn').length
  const doneSla = fCompleted.map(t => slaInfo(t, now).ttr).filter((p): p is SlaPart => !!p)
  const doneOnTime = doneSla.length ? Math.round(100 * doneSla.filter(p => p.state === 'met').length / doneSla.length) : null

  const isBoardData = tab !== 'relatorio'

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Board de chamados · ITSM</h1>
          <p className="meta">
            {snap ? <>Última sincronização: <b>{formatDate(snap.syncedAtUtc)}</b> · {snap.glpiHost} · {(snap.durationMs / 1000).toFixed(1)}s</> : 'Ainda não sincronizado'}
            {data?.stale && snap && <span className="pill warn">desatualizado</span>}
          </p>
        </div>
        <div className="actions">
          {tab !== 'timeline' && <input type="search" placeholder={isBoardData ? 'Filtrar: #id, título, técnico, grupo, entidade…' : 'Filtrar entidade…'} value={filter} onChange={e => setFilter(e.target.value)} />}
          {isBoardData && tab !== 'timeline' && snap && <MultiFilter items={entityStats} selected={entitySel} onChange={setEntitySel} singular="entidade" plural="entidades" icon="🏢" feminine />}
          {tab === 'board' && snap && <MultiFilter items={techStats} selected={techSel} onChange={setTechSel} singular="técnico" plural="técnicos" icon="👤" />}
          {tab === 'board' && snap && (
            <div className="seg sla-seg" role="group" aria-label="Filtro de SLA">
              <span className="seg-label">SLA</span>
              {SLA_FILTERS.map(f => <button key={f.id} type="button" title={f.title} className={slaFilter === f.id ? 'on' : ''} aria-pressed={slaFilter === f.id} onClick={() => setSlaFilter(f.id)}>{f.label}</button>)}
            </div>
          )}
          {isBoardData && (
            <button className="primary" onClick={() => load(true)} disabled={loading}>
              {loading ? 'Sincronizando…' : '⟳ Ressincronizar'}
            </button>
          )}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </nav>

      {tab === 'relatorio' && <MonthlyReportView filter={filter} />}

      {isBoardData && requestError && <div className="banner error">Falha ao consultar o board: {requestError}</div>}
      {isBoardData && data?.lastError && <div className="banner error">Última sincronização com o ITSM falhou ({formatDate(data.lastErrorAtUtc)}): {data.lastError}{snap && ' — exibindo a última leitura válida.'}</div>}
      {isBoardData && notice && <div className="banner info">{notice}</div>}
      {isBoardData && snap && snap.warnings.length > 0 && (
        <details className="banner warn">
          <summary>{snap.warnings.length} aviso(s) de configuração/dados</summary>
          <ul>{snap.warnings.map(w => <li key={w}>{w}</li>)}</ul>
        </details>
      )}

      {tab === 'timeline' && snap && <TimelineView techs={techStats.filter(t => t.id !== NO_TECH)} now={now} />}
      {tab === 'entidades' && snap && <EntitiesView snap={snap} match={textMatch} now={now} selected={entitySel} onSelect={setEntitySel} />}

      {tab === 'board' && snap && cols && (
        <>
          <section className="kpis">
            <Kpi label="Sem atribuição" value={fUnassigned.length} tone="amber" />
            <Kpi label="Em andamento" value={fInProgress} sub={`${lanes.length} técnico(s)`} tone="blue" />
            <Kpi label="Bloqueados (Pendente)" value={fBlocked.length} tone="red" />
            <Kpi label={`Completos · ${snap.doneDays}d`} value={fCompleted.length} tone="green" />
            <Kpi label={`Cancelados · ${snap.doneDays}d`} value={snap.cancelledConfigured ? fCancelled.length : null} tone="gray" />
            <Kpi label="SLA estourado (abertos)" value={slaLate} sub={`${slaWarn} perto de vencer${doneOnTime !== null ? ` · ${doneOnTime}% resolvidos no prazo` : ''}`} tone={slaLate ? 'red' : 'green'} />
          </section>
          {filtering && (
            <p className="filter-note">
              Exibindo dados filtrados
              {entitySel !== null && <> · entidades: <b>{countSel(entityStats, entitySel) <= 2
                ? entityStats.filter(e => entitySel.has(e.id)).map(e => e.name).join(', ') || 'nenhuma'
                : `${countSel(entityStats, entitySel)} de ${entityStats.length}`}</b></>}
              {techSel !== null && <> · técnicos: <b>{countSel(techStats, techSel)} de {techStats.length}</b></>}
              {slaFilter !== 'all' && <> · SLA: <b>{SLA_FILTERS.find(f => f.id === slaFilter)?.label.toLowerCase()}</b></>}
              {filter && <> · texto: <b>“{filter}”</b></>}
              <button type="button" className="link" onClick={clearAll}>Limpar filtros</button>
            </p>
          )}

          <main className="board">
            <Column title="1 · Sem atribuição" hint="Status Novo/Em atendimento sem técnico atribuído" tone="amber" count={fUnassigned.length}>
              {fUnassigned.map(t => <Card key={t.id} t={t} now={now} th={th} showGroups />)}
            </Column>

            <Column title="2 · Em andamento" hint="Agrupado pelo técnico atribuído (observadores ignorados)" tone="blue" wide count={fInProgress}>
              {lanes.length === 0 && <Empty />}
              {lanes.map(l => <Lane key={l.id} lane={l} now={now} th={th} />)}
            </Column>

            <Column title="3 · Completos" hint={`Solucionados/fechados nos últimos ${snap.doneDays} dias`} tone="green" count={fCompleted.length}>
              {fCompleted.map(t => <Card key={t.id} t={t} now={now} th={th} done showTech />)}
            </Column>

            <Column title="4 · Bloqueados" hint="Status Pendente no ITSM" tone="red" count={fBlocked.length}>
              {fBlocked.map(t => <Card key={t.id} t={t} now={now} th={th} showTech showGroups />)}
            </Column>

            <Column title="5 · Cancelados" hint="Por tipo de solução configurado" tone="gray" count={snap.cancelledConfigured ? fCancelled.length : null}>
              {!snap.cancelledConfigured
                ? <p className="empty">Regra de cancelamento não configurada. O ITSM não possui status “Cancelado”; defina <code>BOARD_CANCELLED_SOLUTIONTYPE_IDS</code>. Nenhum dado é inferido.</p>
                : fCancelled.map(t => <Card key={t.id} t={t} now={now} th={th} done showTech />)}
            </Column>
          </main>
        </>
      )}
      {isBoardData && !snap && loading && <p className="empty center">Sincronizando com o ITSM…</p>}
      {isBoardData && !snap && !loading && !requestError && !data?.lastError && <p className="empty center">Sem dados.</p>}
      <footer>Tempo aberto = tempo corrido desde a abertura do chamado (24×7). SLA = prazos de atendimento e solução calculados pelo ITSM (calendário da SLA); “perto de vencer” = resta ≤ 25% do prazo. Dados lidos diretamente do ITSM; nada é estimado.</footer>
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: number | null | undefined; sub?: string; tone: string }) {
  return (
    <div className={`kpi tone-${tone}`}>
      <span className="kpi-value">{value ?? 'n/d'}</span>
      <span className="kpi-label">{label}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  )
}

function Column({ title, hint, tone, count, wide, children }: { title: string; hint: string; tone: string; count: number | null; wide?: boolean; children: React.ReactNode }) {
  const empty = Array.isArray(children) ? children.length === 0 : !children
  return (
    <section className={`col tone-${tone}${wide ? ' wide' : ''}`}>
      <header>
        <h2>{title}<span className="count">{count ?? 'n/d'}</span></h2>
        <p>{hint}</p>
      </header>
      <div className="col-body">{empty ? <Empty /> : children}</div>
    </section>
  )
}

const Empty = () => <p className="empty">Nenhum item.</p>

function Lane({ lane, now, th }: { lane: TechnicianLane; now: Date; th: Thresholds }) {
  const [open, setOpen] = useState(true)
  const ages = lane.tickets.map(t => hoursBetween(t.openedAtUtc, now) ?? 0)
  const oldest = ages.length ? Math.max(...ages) : null
  const critical = ages.filter(a => a >= th.crit).length
  return (
    <div className="lane">
      <button className="lane-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="avatar">{initials(lane.name)}</span>
        <span className="lane-name">{lane.name}</span>
        <span className="lane-stats">
          {lane.tickets.length} item(ns) · mais antigo {formatDuration(oldest)}
          {critical > 0 && <span className="pill crit">{critical} crítico(s)</span>}
        </span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && lane.tickets.map(t => <Card key={t.id} t={t} now={now} th={th} coTechs={t.technicians.filter(x => x.id !== lane.id)} />)}
    </div>
  )
}

function Card({ t, now, th, done, showTech, showGroups, coTechs }: {
  t: BoardTicket; now: Date; th: Thresholds; done?: boolean; showTech?: boolean; showGroups?: boolean; coTechs?: { id: number; name: string }[]
}) {
  const end = done ? (t.solvedAtUtc ?? t.closedAtUtc) : null
  const age = done ? (end ? hoursBetween(t.openedAtUtc, new Date(end)) : null) : hoursBetween(t.openedAtUtc, now)
  const level = done || age === null ? '' : age >= th.crit ? 'crit' : age >= th.warn ? 'warn' : 'ok'
  const sla = slaInfo(t, now)
  return (
    <article className={`card ${level}${sla.worst === 'late' ? ' sla-late' : ''}`}>
      <div className="card-top">
        <a href={t.url} target="_blank" rel="noopener noreferrer" className="id">#{t.id}</a>
        {t.priority != null && t.priority >= 4 && <span className="pill prio">{t.priorityLabel}</span>}
        <span className={`age ${level}`} title={done ? 'Tempo da abertura até a solução' : `Aberto em ${formatDate(t.openedAtUtc)}`}>
          {done ? `resolvido em ${formatDuration(age)}` : `aberto há ${formatDuration(age)}`}
        </span>
      </div>
      <h3 title={t.title}>{t.title}</h3>
      {(sla.tto || sla.ttr) && (
        <div className="sla">
          {sla.tto && <SlaChip label="Atend." p={sla.tto} />}
          {sla.ttr && <SlaChip label="Solução" p={sla.ttr} />}
        </div>
      )}
      <dl>
        <dt>Entidade</dt><dd title={t.entity ?? ''} className="entity">{shortEntity(t.entity)}</dd>
        {t.category && <><dt>Categoria</dt><dd>{t.category}</dd></>}
        {showTech && <><dt>Técnico</dt><dd>{t.technicians.length ? t.technicians.map(x => x.name).join(', ') : <i>não atribuído</i>}</dd></>}
        {coTechs && coTechs.length > 0 && <><dt>Divide com</dt><dd>{coTechs.map(x => x.name).join(', ')}</dd></>}
        {(showGroups || t.assignedGroups.length > 0) && <><dt>Grupo</dt><dd>{t.assignedGroups.length ? t.assignedGroups.join(', ') : <i>—</i>}</dd></>}
        {done && <><dt>{t.status === 6 ? 'Fechado' : 'Solucionado'}</dt><dd>{formatDate(end)}</dd></>}
        {t.solutionType && <><dt>Tipo solução</dt><dd>{t.solutionType}</dd></>}
        {!done && <><dt>Status</dt><dd>{t.statusLabel}</dd></>}
      </dl>
      {t.flags.length > 0 && <div className="flags">{t.flags.map(f => <span key={f} className="pill flag">⚠ {f}</span>)}</div>}
    </article>
  )
}

const SLA_ICON = { ok: '◷', warn: '◷', late: '!', met: '✓', missed: '✗', paused: '⏸' } as const
function SlaChip({ label, p }: { label: string; p: SlaPart }) {
  return <span className={`sla-chip ${p.state}`} title={p.title}><i aria-hidden>{SLA_ICON[p.state]}</i>{label} <b>{p.text}</b></span>
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join('') || '?'

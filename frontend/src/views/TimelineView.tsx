import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TimelineEvent, TimelineResponse, TimelineTicket } from '../types'
import { apiUrl, formatDate, formatDuration } from '../format'
import { shortEntity } from '../entity'

export interface TechOption { id: number; name: string; open: number; blocked: number; done: number }

const DAY = 864e5
const PERIODS: { id: string; label: string; days: number | null }[] = [
  { id: '7', label: '7 dias', days: 7 }, { id: '30', label: '30 dias', days: 30 }, { id: '90', label: '90 dias', days: 90 },
  { id: '365', label: '1 ano', days: 365 }, { id: 'all', label: 'Tudo', days: null },
]
type Sort = 'opened' | 'updated' | 'duration'
const STATUS_CLASS: Record<number, string> = { 0: 's0', 1: 's1', 2: 's2', 3: 's3', 4: 's4', 5: 's5', 6: 's6' }
const KIND_LABEL: Record<string, string> = { followup: 'Acompanhamento', task: 'Tarefa', solution: 'Solução', assign: 'Atribuição', document: 'Documento', status: 'Mudança de status' }

const ls = { get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* sem storage */ } } }

type Tip = { x: number; y: number; title: string; lines: string[] } | null

export default function TimelineView({ techs, now }: { techs: TechOption[]; now: Date }) {
  const sortedTechs = useMemo(() => [...techs].sort((a, b) => a.name.localeCompare(b.name)), [techs])
  const [techId, setTechId] = useState<number | null>(() => Number(ls.get('timeline.tech')) || null)
  const [period, setPeriod] = useState(() => ls.get('timeline.period') ?? '30')
  const [onlyOpen, setOnlyOpen] = useState(() => ls.get('timeline.onlyOpen') === '1')
  const [sort, setSort] = useState<Sort>(() => (ls.get('timeline.sort') as Sort) ?? 'opened')
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip>(null)

  // técnico padrão: o com mais tickets em aberto
  const effectiveTech = techId !== null && techs.some(t => t.id === techId) ? techId : (techs[0]?.id ?? null)

  const load = useCallback(async (id: number) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(apiUrl(`/api/timeline?tech=${id}`), { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
      setData(body as TimelineResponse)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (effectiveTech !== null) void load(effectiveTech) }, [effectiveTech, load])

  const pickTech = (id: number) => { setTechId(id); ls.set('timeline.tech', String(id)) }
  const pickPeriod = (p: string) => { setPeriod(p); setTip(null); ls.set('timeline.period', p) }
  const pickOnlyOpen = (v: boolean) => { setOnlyOpen(v); ls.set('timeline.onlyOpen', v ? '1' : '0') }
  const pickSort = (s: Sort) => { setSort(s); ls.set('timeline.sort', s) }

  const nowMs = now.getTime()
  const endOf = useCallback((t: TimelineTicket) => t.endAtUtc ? Date.parse(t.endAtUtc) : nowMs, [nowMs])
  const startOf = (t: TimelineTicket) => t.openedAtUtc ? Date.parse(t.openedAtUtc) : nowMs

  const tickets = useMemo(() => {
    const list = (data?.tickets ?? []).filter(t => !onlyOpen || !t.endAtUtc)
    const key: Record<Sort, (t: TimelineTicket) => number> = {
      opened: t => startOf(t),
      updated: t => -(t.lastUpdateUtc ? Date.parse(t.lastUpdateUtc) : 0),
      duration: t => -(endOf(t) - startOf(t)),
    }
    return [...list].sort((a, b) => key[sort](a) - key[sort](b))
  }, [data, onlyOpen, sort, endOf])

  // janela de tempo
  const days = PERIODS.find(p => p.id === period)?.days ?? null
  const minStart = tickets.length ? Math.min(...tickets.map(startOf)) : nowMs - 30 * DAY
  const winEnd = nowMs + (days ? days : (nowMs - minStart) / DAY) * DAY * 0.02 // pequena folga à direita
  const winStart = days ? nowMs - days * DAY : minStart - (nowMs - minStart) * 0.01
  const span = Math.max(winEnd - winStart, 3600e3)
  const pct = (ms: number) => ((Math.min(Math.max(ms, winStart), winEnd) - winStart) / span) * 100
  // marcas do eixo, sem as que ficariam coladas no rótulo "agora"
  const ticks = useMemo(() => makeTicks(winStart, winEnd).filter(k => Math.abs(k.ms - nowMs) / (winEnd - winStart) > 0.04), [winStart, winEnd, nowMs])

  const visibleInWindow = tickets.filter(t => endOf(t) >= winStart)
  const hiddenOld = tickets.length - visibleInWindow.length

  const showTip = (e: React.MouseEvent, title: string, lines: string[]) => setTip({ x: e.clientX, y: e.clientY, title, lines })
  const moveTip = (e: React.MouseEvent) => setTip(t => t ? { ...t, x: e.clientX, y: e.clientY } : t)
  const hideTip = () => setTip(null)

  const tech = techs.find(t => t.id === effectiveTech)

  return (
    <section className="panel tl">
      <header className="panel-head row">
        <div className="tl-pick">
          <label htmlFor="tl-tech" className="muted">Técnico</label>
          <select id="tl-tech" value={effectiveTech ?? ''} onChange={e => pickTech(Number(e.target.value))}>
            {sortedTechs.map(t => <option key={t.id} value={t.id}>{t.name} — {t.open} aberto(s), {t.blocked} bloq., {t.done} compl.</option>)}
          </select>
          {tech && <span className="muted tl-sum">{tickets.length} ticket(s){data && ` · completos dos últimos ${data.doneDays} dias incluídos`}</span>}
        </div>
        <div className="actions">
          <div className="seg">{PERIODS.map(p => <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => pickPeriod(p.id)}>{p.label}</button>)}</div>
          <select value={sort} onChange={e => pickSort(e.target.value as Sort)} aria-label="Ordenar">
            <option value="opened">Ordenar: abertura</option>
            <option value="updated">Ordenar: última atualização</option>
            <option value="duration">Ordenar: maior duração</option>
          </select>
          <label className="check"><input type="checkbox" checked={onlyOpen} onChange={e => pickOnlyOpen(e.target.checked)} /> Só em aberto</label>
          <button className="primary" onClick={() => effectiveTech !== null && load(effectiveTech)} disabled={loading || effectiveTech === null}>{loading ? 'Carregando…' : '⟳ Atualizar'}</button>
        </div>
      </header>

      <div className="tl-legend">
        <span><i className="sw s1" />Novo</span><span><i className="sw s2" />Em atendimento</span><span><i className="sw s3" />Planejado</span>
        <span><i className="sw s4" />Pendente</span><span><i className="sw s5" />Solucionado</span><span><i className="sw s6" />Fechado</span>
        <span className="sep" />
        <span><i className="mk status s2" />Mudança de status</span><span><i className="mk followup" />Acompanhamento</span>
        <span><i className="mk task" />Tarefa</span><span><i className="mk solution" />Solução</span><span><i className="mk assign" />Atribuição</span><span><i className="mk document" />Documento</span>
      </div>

      {error && <div className="banner error">Falha ao carregar a linha do tempo: {error}</div>}
      {data?.error && <div className="banner error">{data.error}</div>}
      {data && data.warnings.length > 0 && <div className="banner warn">{data.warnings.join(' ')}</div>}
      {techs.length === 0 && <p className="empty center">Nenhum técnico com tickets no board.</p>}
      {loading && !data && <p className="empty center">Lendo o histórico dos tickets no ITSM… (a primeira leitura de um técnico pode levar alguns segundos)</p>}

      {data && (
        <div className={`tl-grid${loading ? ' dim' : ''}`} onMouseLeave={hideTip}>
          <div className="tl-row tl-axis">
            <div className="tl-left">Ticket <span className="muted">· duração · última atualização</span></div>
            <div className="tl-track">
              {ticks.map(k => <span key={k.ms} className={`tl-tick${k.major ? ' major' : ''}`} style={{ left: `${pct(k.ms)}%` }}>{k.label}</span>)}
              <span className="tl-now-label" style={{ left: `${pct(nowMs)}%` }}>agora</span>
            </div>
          </div>

          {visibleInWindow.map(t => {
            const s = startOf(t), e = endOf(t)
            const clippedLeft = s < winStart
            const dur = (e - s) / 36e5
            const upd = t.lastUpdateUtc ? (nowMs - Date.parse(t.lastUpdateUtc)) / 36e5 : null
            return (
              <div key={t.id} className="tl-row">
                <div className="tl-left">
                  <div className="tl-title">
                    <a className="id" href={t.url} target="_blank" rel="noopener noreferrer">#{t.id}</a>
                    <span title={t.title}>{t.title}</span>
                  </div>
                  <div className="tl-meta">
                    <span className={`tl-status ${STATUS_CLASS[t.status] ?? 's0'}`}>{t.statusLabel}</span>
                    <span title={t.endAtUtc ? 'Da abertura até a solução/fechamento' : 'Aberto há'}>⏱ {formatDuration(dur)}{t.endAtUtc ? '' : ' (aberto)'}</span>
                    <span title={`Última atualização: ${formatDate(t.lastUpdateUtc)}`}>↻ {upd === null ? '—' : `há ${formatDuration(upd)}`}</span>
                  </div>
                  <div className="tl-ent" title={t.entity ?? ''}>{shortEntity(t.entity)}</div>
                </div>
                <div className="tl-track">
                  {ticks.map(k => <span key={k.ms} className={`tl-grid-line${k.major ? ' major' : ''}`} style={{ left: `${pct(k.ms)}%` }} />)}
                  <span className="tl-now" style={{ left: `${pct(nowMs)}%` }} />
                  {clippedLeft && <span className="tl-clip" title={`Aberto em ${formatDate(t.openedAtUtc)} (antes do período exibido)`}>◀</span>}
                  {t.segments.map((sg, i) => {
                    const a = Date.parse(sg.fromUtc), b = sg.toUtc ? Date.parse(sg.toUtc) : nowMs
                    if (b < winStart || a > winEnd) return null
                    const l = pct(a), w = Math.max(pct(b) - l, 0.25)
                    return (
                      <span key={i} className={`tl-seg ${STATUS_CLASS[sg.status] ?? 's0'}${i === 0 && !clippedLeft ? ' first' : ''}${i === t.segments.length - 1 ? ' last' : ''}${!sg.toUtc ? ' ongoing' : ''}`}
                        style={{ left: `${l}%`, width: `${w}%` }}
                        onMouseEnter={ev => showTip(ev, sg.label, [`${formatDate(sg.fromUtc)} → ${sg.toUtc ? formatDate(sg.toUtc) : 'agora'}`, `Duração: ${formatDuration((b - a) / 36e5)}`])}
                        onMouseMove={moveTip} onMouseLeave={hideTip} />
                    )
                  })}
                  {groupEvents(t.events).map(g => {
                    const at = Date.parse(g.atUtc)
                    if (at < winStart || at > winEnd) return null
                    const st = g.events.find(x => x.kind === 'status')
                    const kind = st ? 'status' : g.events[0]!.kind
                    return (
                      <span key={g.atUtc} className={`tl-mk ${kind}${st ? ` ${STATUS_CLASS[st.toStatus ?? 0]}` : ''}`} style={{ left: `${pct(at)}%` }}
                        onMouseEnter={ev => showTip(ev, formatDate(g.atUtc), g.events.map(x => `${x.kind === 'status' ? '◆ ' : '• '}${x.kind === 'status' ? x.label : KIND_LABEL[x.kind] ?? x.label}${x.kind === 'assign' || x.kind === 'document' ? ` — ${x.label.split(': ').slice(1).join(': ')}` : ''}${x.user ? ` (${x.user})` : ''}`))}
                        onMouseMove={moveTip} onMouseLeave={hideTip}>
                        {st && <span className="tl-mk-line" />}
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {visibleInWindow.length === 0 && <p className="empty center">Nenhum ticket neste período.</p>}
          {hiddenOld > 0 && <p className="muted tl-foot">{hiddenOld} ticket(s) encerrado(s) antes do período exibido — escolha “Tudo” para vê-los.</p>}
        </div>
      )}

      {tip && (
        <div className="tl-tip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 320), top: tip.y + 14 }}>
          <b>{tip.title}</b>
          {tip.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </section>
  )
}

/** Agrupa eventos no mesmo instante (o GLPI grava várias linhas de log por ação). */
function groupEvents(evs: TimelineEvent[]) {
  const m = new Map<string, TimelineEvent[]>()
  for (const e of evs) { const k = e.atUtc.slice(0, 19); m.set(k, [...(m.get(k) ?? []), e]) }
  return [...m.entries()].map(([, events]) => ({ atUtc: events[0]!.atUtc, events }))
}

const fmtDay = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' })
const fmtMonth = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' })

/** Marcas do eixo: diárias, semanais (segunda) ou mensais conforme o período. */
function makeTicks(start: number, end: number) {
  const days = (end - start) / DAY
  const out: { ms: number; label: string; major: boolean }[] = []
  const d = new Date(start); d.setHours(0, 0, 0, 0)
  if (days <= 14) {
    for (; d.getTime() <= end; d.setDate(d.getDate() + 1)) if (d.getTime() >= start) out.push({ ms: d.getTime(), label: fmtDay.format(d), major: d.getDay() === 1 })
  } else if (days <= 120) {
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1)
    for (; d.getTime() <= end; d.setDate(d.getDate() + 7)) out.push({ ms: d.getTime(), label: fmtDay.format(d), major: d.getDate() <= 7 })
  } else {
    d.setDate(1); d.setMonth(d.getMonth() + 1)
    const step = days > 800 ? 3 : 1
    for (; d.getTime() <= end; d.setMonth(d.getMonth() + step)) out.push({ ms: d.getTime(), label: fmtMonth.format(d).replace('.', '').replace(' de ', '/'), major: d.getMonth() === 0 })
  }
  return out
}

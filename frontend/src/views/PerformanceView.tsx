import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SlaReportResponse, SlaReportTicket } from '../types'
import { apiUrl, formatDate } from '../format'
import { NO_ENTITY, shortEntity } from '../entity'

/* ---------- período ---------- */
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseDay = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y!, m! - 1, d!) }
const addDays = (iso: string, n: number) => { const d = parseDay(iso); d.setDate(d.getDate() + n); return ymd(d) }
const daysBetween = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 864e5) + 1
const fmtDay = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
const MAX_DAYS = 366

type Preset = 'hoje' | 'ontem' | '7d' | 'mes' | 'mesant' | '30d' | '90d' | 'custom'
const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'hoje', label: 'Hoje' }, { id: 'ontem', label: 'Ontem' }, { id: '7d', label: '7 dias' }, { id: 'mes', label: 'Este mês' },
  { id: 'mesant', label: 'Mês anterior' }, { id: '30d', label: '30 dias' }, { id: '90d', label: '90 dias' },
]
function presetRange(p: Exclude<Preset, 'custom'>): [string, string] {
  const t = ymd(new Date())
  switch (p) {
    case 'hoje': return [t, t]
    case 'ontem': { const y = addDays(t, -1); return [y, y] }
    case '7d': return [addDays(t, -6), t]
    case '30d': return [addDays(t, -29), t]
    case '90d': return [addDays(t, -89), t]
    case 'mes': return [t.slice(0, 8) + '01', t]
    case 'mesant': { const n = new Date(); return [ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)), ymd(new Date(n.getFullYear(), n.getMonth(), 0))] }
  }
}

/* ---------- tempos ---------- */
type Mode = 'util' | 'corrido'
const MODES: { id: Mode; label: string; title: string }[] = [
  { id: 'util', label: 'Horário útil', title: 'Calendário do SLA no ITSM, sem o tempo Pendente (mesma base dos prazos de SLA)' },
  { id: 'corrido', label: 'Corrido 24×7', title: 'Tempo de relógio, incluindo noites, fins de semana e tempo Pendente' },
]
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null)
/** Segundos → "3d 4h", "5h 20min", "12 min" (horário útil mostra só horas). */
function dur(sec: number | null | undefined, hoursOnly = false): string {
  if (sec === null || sec === undefined) return '—'
  const s = Math.max(0, sec)
  if (s < 3600) return `${Math.max(s ? 1 : 0, Math.round(s / 60))} min`
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  if (hoursOnly && h >= 24) return `${h}h`
  if (hoursOnly || h < 24) return m ? `${h}h ${pad(m)}min` : `${h}h`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i]! : (s[i - 1]! + s[i]!) / 2
}
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—')
const NO_TECH = -1

interface Item {
  t: SlaReportTicket
  techs: number[]
  openMs: number | null
  startMs: number          // início do atendimento (assumido; sem isso, abertura)
  endMs: number            // solução (sem solução: fechamento)
  tto: Record<Mode, number | null>   // s até iniciar o atendimento
  ttr: Record<Mode, number | null>   // s até a solução
}

function toItem(t: SlaReportTicket): Item | null {
  const endMs = ms(t.solvedAtUtc ?? t.closedAtUtc)
  if (endMs === null) return null
  const openMs = ms(t.openedAtUtc)
  const taken = (t.takeDelaySec ?? 0) > 0
  const takenMs = taken ? ms(t.takenAtUtc) : null
  const pos = (x: number | null | undefined) => (x !== null && x !== undefined && x > 0 ? x : null)
  return {
    t, techs: t.techIds.length ? t.techIds : [NO_TECH], openMs, endMs,
    startMs: takenMs ?? openMs ?? endMs,
    tto: { util: taken ? t.takeDelaySec : null, corrido: takenMs !== null && openMs !== null ? pos((takenMs - openMs) / 1000) : null },
    ttr: { util: pos(t.solveDelaySec), corrido: openMs !== null ? pos((endMs - openMs) / 1000) : null },
  }
}

/* ---------- atendimento em paralelo ---------- */
interface EntityPar {
  entity: string
  total: number                      // tickets da empresa no período
  items: Item[]                      // tickets que ficaram em atendimento junto com outro da mesma empresa
  peak: number                       // máximo de tickets ao mesmo tempo
  peakAt: number                     // primeiro momento em que o pico aconteceu
  peakItems: Item[]                  // tickets em atendimento nesse momento
  windows: [number, number][]        // trechos com 2+ tickets em atendimento
  overlapSec: number
  techs: number[]
}

/**
 * Por empresa: períodos de atendimento (assumido → solução) que se sobrepõem.
 * Varredura de eventos: n = tickets em atendimento; trechos com n ≥ 2 são "em paralelo".
 */
function parallelByEntity(items: Item[]): EntityPar[] {
  const byEnt = new Map<string, Item[]>()
  for (const it of items) {
    const e = it.t.entity
    if (!e || it.endMs <= it.startMs) continue
    if (!byEnt.has(e)) byEnt.set(e, [])
    byEnt.get(e)!.push(it)
  }
  const out: EntityPar[] = []
  for (const [entity, list] of byEnt) {
    if (list.length < 2) continue
    // fim antes de início no mesmo instante: encostar não é sobrepor
    const ev = list.flatMap(i => [[i.startMs, 1, i], [i.endMs, -1, i]] as [number, number, Item][]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const active = new Set<Item>()
    let peak = 0, peakAt = 0, peakItems: Item[] = [], open: number | null = null
    const windows: [number, number][] = []
    for (const [at, d, it] of ev) {
      if (d > 0) active.add(it); else active.delete(it)
      if (active.size > peak) { peak = active.size; peakAt = at; peakItems = [...active] }
      if (active.size >= 2 && open === null) open = at
      else if (active.size < 2 && open !== null) { if (at > open) windows.push([open, at]); open = null }
    }
    if (!windows.length) continue
    const par = list.filter(i => windows.some(([a, b]) => i.startMs < b && i.endMs > a))
    out.push({
      entity, total: list.length, items: par.sort((a, b) => a.startMs - b.startMs), peak, peakAt,
      peakItems: peakItems.sort((a, b) => a.startMs - b.startMs), windows,
      overlapSec: windows.reduce((s, [a, b]) => s + (b - a) / 1000, 0),
      techs: [...new Set(par.flatMap(i => i.techs))],
    })
  }
  return out.sort((a, b) => b.items.length - a.items.length || b.peak - a.peak)
}

/* ---------- tooltip ---------- */
type Tip = { x: number; y: number; body: ReactNode } | null
const TipCtx = createContext<(t: Tip) => void>(() => {})
function tipProps(set: (t: Tip) => void, body: () => ReactNode) {
  return {
    onMouseMove: (e: React.MouseEvent) => set({ x: e.clientX, y: e.clientY, body: body() }),
    onMouseLeave: () => set(null),
  }
}

interface Props { filter: string; entitySel: Set<string> | null; techSel: Set<number> | null }

export default function PerformanceView({ filter, entitySel, techSel }: Props) {
  const [preset, setPreset] = useState<Preset>(() => { try { const v = localStorage.getItem('perf.preset'); return PRESETS.some(p => p.id === v) ? v as Preset : 'mes' } catch { return 'mes' } })
  const [range, setRange] = useState<[string, string]>(() => presetRange(preset === 'custom' ? 'mes' : preset))
  const [mode, setMode] = useState<Mode>(() => { try { return localStorage.getItem('perf.mode') === 'corrido' ? 'corrido' : 'util' } catch { return 'util' } })
  const [data, setData] = useState<SlaReportResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip>(null)
  const [pickedEntity, setPickedEntity] = useState<string | null>(null)
  const [showClusters, setShowClusters] = useState(12)
  const [from, to] = range
  const hoursOnly = mode === 'util'
  const d = (s: number | null | undefined) => dur(s, hoursOnly)

  useEffect(() => { try { if (preset !== 'custom') localStorage.setItem('perf.preset', preset) } catch { /* sem storage */ } }, [preset])
  useEffect(() => { try { localStorage.setItem('perf.mode', mode) } catch { /* sem storage */ } }, [mode])

  const resetView = () => { setPickedEntity(null); setShowClusters(12) }
  const choose = (p: Exclude<Preset, 'custom'>) => { setPreset(p); setRange(presetRange(p)); resetView() }
  const setDay = (which: 0 | 1, v: string) => {
    if (!v) return
    setPreset('custom'); resetView()
    setRange(([a, b]) => {
      let f = which === 0 ? v : a, t = which === 1 ? v : b
      if (t < f) { if (which === 0) t = f; else f = t }
      if (daysBetween(f, t) > MAX_DAYS) { if (which === 0) t = addDays(f, MAX_DAYS - 1); else f = addDays(t, -(MAX_DAYS - 1)) }
      return [f, t]
    })
  }

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(apiUrl(`/api/reports/performance?from=${from}&to=${to}${refresh ? '&refresh=true' : ''}`), { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
      setData(body as SlaReportResponse)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { void load(false) }, [load])

  const rep = data?.report ?? null
  const names = useMemo(() => new Map((rep?.technicians ?? []).map(t => [t.id, t.name])), [rep])
  const techName = useCallback((id: number) => (id === NO_TECH ? 'Sem técnico' : names.get(id) ?? `Usuário #${id}`), [names])
  const techList = (ids: number[]) => ids.map(techName).join(', ')

  // tickets do período com os filtros do topo (ticket com 2 técnicos aparece para os dois)
  const items = useMemo(() => {
    if (!rep) return []
    const q = filter.trim().toLowerCase()
    const out: Item[] = []
    for (const t of rep.tickets) {
      const it = toItem(t)
      if (!it) continue
      if (entitySel !== null && !entitySel.has(t.entity ?? NO_ENTITY)) continue
      if (techSel !== null && !it.techs.some(id => techSel.has(id))) continue
      if (q && !`#${t.id} ${t.title} ${t.entity ?? ''} ${it.techs.map(techName).join(' ')}`.toLowerCase().includes(q)) continue
      out.push(it)
    }
    return out
  }, [rep, filter, entitySel, techSel, techName])

  const par = useMemo(() => parallelByEntity(items), [items])
  const inCluster = useMemo(() => new Set(par.flatMap(c => c.items.map(i => i.t.id))), [par])
  const parPeak = par.reduce<EntityPar | null>((b, e) => (!b || e.peak > b.peak ? e : b), null)
  const picked = par.find(e => e.entity === pickedEntity) ?? par[0] ?? null
  const axis: [number, number] = [parseDay(from).getTime(), parseDay(addDays(to, 1)).getTime()]

  // por técnico
  const techRows = useMemo(() => {
    const m = new Map<number, Item[]>()
    for (const it of items) for (const id of it.techs) {
      if (techSel !== null && !techSel.has(id)) continue
      if (!m.has(id)) m.set(id, [])
      m.get(id)!.push(it)
    }
    return [...m.entries()].map(([id, list]) => {
      const tto = list.map(i => i.tto[mode]).filter((x): x is number => x !== null)
      const ttr = list.map(i => i.ttr[mode]).filter((x): x is number => x !== null)
      return {
        id, name: techName(id), n: list.length,
        solved: list.filter(i => i.t.status === 5).length, closed: list.filter(i => i.t.status === 6).length,
        ttoAvg: avg(tto), ttoMed: median(tto), ttoN: tto.length,
        ttrAvg: avg(ttr), ttrMed: median(ttr), ttrN: ttr.length,
        par: list.filter(i => inCluster.has(i.t.id)).length,
      }
    }).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
  }, [items, techSel, mode, techName, inCluster])

  // totais (tickets únicos)
  const ttoAll = items.map(i => i.tto[mode]).filter((x): x is number => x !== null)
  const ttrAll = items.map(i => i.ttr[mode]).filter((x): x is number => x !== null)
  const noTake = items.length - ttoAll.length

  // volume por dia (ou por mês em períodos longos)
  const volume = useMemo(() => {
    const byMonth = daysBetween(from, to) > 92
    const keyOf = (t: number) => { const s = ymd(new Date(t)); return byMonth ? s.slice(0, 7) : s }
    const counts = new Map<string, number>()
    for (const it of items) counts.set(keyOf(it.endMs), (counts.get(keyOf(it.endMs)) ?? 0) + 1)
    const keys: string[] = []
    if (byMonth) { for (let k = from.slice(0, 7); k <= to.slice(0, 7);) { keys.push(k); const [y, m] = k.split('-').map(Number); k = `${m === 12 ? y! + 1 : y}-${pad(m === 12 ? 1 : m! + 1)}` } }
    else for (let k = from; k <= to; k = addDays(k, 1)) keys.push(k)
    const mfmt = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    const wfmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' })
    return {
      byMonth,
      points: keys.map(k => ({
        key: k, value: counts.get(k) ?? 0,
        label: byMonth ? mfmt.format(new Date(`${k}-01T00:00:00Z`)) : `${k.slice(8)}/${k.slice(5, 7)}`,
        long: byMonth ? mfmt.format(new Date(`${k}-01T00:00:00Z`)) : `${wfmt.format(parseDay(k))} ${fmtDay(k)}`,
      })),
    }
  }, [items, from, to])

  const top = (key: 'tto' | 'ttr', dir: 1 | -1) => items.filter(i => i[key][mode] !== null).sort((a, b) => dir * ((a[key][mode] ?? 0) - (b[key][mode] ?? 0))).slice(0, 10)
  const slowTto = top('tto', -1), slowTtr = top('ttr', -1), fastTtr = top('ttr', 1)

  const exportCsv = () => {
    const esc = (s: string | number | null | undefined) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const h = (s: number | null) => (s === null ? '' : (s / 3600).toFixed(2).replace('.', ','))
    const group = new Map([...inCluster].map(id => [id, 'sim'] as const))
    const lines = [['Ticket', 'Título', 'Entidade', 'Técnicos', 'Status', 'Abertura', 'Início do atendimento', 'Solução', 'Até iniciar - útil (h)', 'Até iniciar - corrido (h)', 'Até solucionar - útil (h)', 'Até solucionar - corrido (h)', 'Em paralelo na mesma empresa'].map(esc).join(';')]
    for (const it of items) {
      const t = it.t
      lines.push([t.id, t.title, t.entity, techList(it.techs), t.statusLabel, formatDate(t.openedAtUtc), it.tto.util !== null || it.tto.corrido !== null ? formatDate(t.takenAtUtc) : '',
        formatDate(new Date(it.endMs).toISOString()), h(it.tto.util), h(it.tto.corrido), h(it.ttr.util), h(it.ttr.corrido), group.get(t.id) ?? ''].map(esc).join(';'))
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `desempenho-${from}${from === to ? '' : '_' + to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const period = from === to ? fmtDay(from) : `${fmtDay(from)} a ${fmtDay(to)}`
  const modeNote = mode === 'util' ? 'horário útil' : 'tempo corrido'

  return (
    <TipCtx.Provider value={setTip}>
      <section className="panel pf">
        <header className="panel-head row">
          <div>
            <h2>Desempenho do atendimento</h2>
            <p>
              Tickets <b>solucionados ou fechados</b> em <b>{period}</b> · dados do ITSM
              {rep && <> · gerado em {formatDate(rep.generatedAtUtc)} ({(rep.durationMs / 1000).toFixed(1)}s)</>}
            </p>
          </div>
          <div className="actions">
            <button type="button" onClick={exportCsv} disabled={!items.length}>Exportar CSV</button>
            <button type="button" className="primary" onClick={() => load(true)} disabled={loading}>{loading ? 'Carregando…' : '⟳ Atualizar'}</button>
          </div>
        </header>

        <div className="pf-filters">
          <div className="seg" role="group" aria-label="Período">
            {PRESETS.map(p => <button key={p.id} type="button" className={preset === p.id ? 'on' : ''} aria-pressed={preset === p.id} onClick={() => choose(p.id)}>{p.label}</button>)}
          </div>
          <label className="pf-date">De <input type="date" value={from} max={to} onChange={e => setDay(0, e.target.value)} /></label>
          <label className="pf-date">até <input type="date" value={to} min={from} onChange={e => setDay(1, e.target.value)} /></label>
          <div className="seg" role="group" aria-label="Como contar o tempo">
            {MODES.map(m => <button key={m.id} type="button" title={m.title} className={mode === m.id ? 'on' : ''} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
          </div>
        </div>

        {error && <div className="banner error">Falha ao gerar o relatório: {error}</div>}
        {data?.error && <div className="banner error">Falha ao consultar o ITSM: {data.error}{rep && ' — exibindo o último relatório gerado.'}</div>}
        {data?.throttledSeconds && <div className="banner info">Atualização limitada a 1 a cada {data.throttledSeconds}s — exibindo o último relatório.</div>}
        {rep?.warnings.map(w => <div key={w} className="banner warn">{w}</div>)}
        {!rep && loading && <p className="empty center">Gerando relatório…</p>}

        {rep && (
          <>
            {/* ---------- visão geral ---------- */}
            <section className="kpis pf-kpis" aria-label="Visão geral">
              <div className="kpi tone-gray"><span className="kpi-value">{items.length}</span><span className="kpi-label">Tickets solucionados/fechados</span><span className="kpi-sub">{techRows.filter(r => r.id !== NO_TECH).length} técnico(s) · {new Set(items.map(i => i.t.entity)).size} empresa(s)</span></div>
              <div className="kpi pf-kpi-tto"><span className="kpi-value">{d(avg(ttoAll))}</span><span className="kpi-label">Tempo médio para iniciar o atendimento</span><span className="kpi-sub">mediana {d(median(ttoAll))} · {modeNote}</span></div>
              <div className="kpi pf-kpi-ttr"><span className="kpi-value">{d(avg(ttrAll))}</span><span className="kpi-label">Tempo médio para solução</span><span className="kpi-sub">mediana {d(median(ttrAll))} · {modeNote}</span></div>
              <div className="kpi pf-kpi-par"><span className="kpi-value">{parPeak ? parPeak.peak : 0}</span><span className="kpi-label">Máximo de tickets simultâneos da mesma empresa</span><span className="kpi-sub">{parPeak ? <>{shortEntity(parPeak.entity)} · {par.length} empresa(s) com atendimento em paralelo</> : 'nenhum atendimento em paralelo'}</span></div>
            </section>

            {items.length === 0 ? <p className="empty center">Nenhum ticket solucionado ou fechado no período com os filtros atuais.</p> : <>

              {/* ---------- 1. volume ---------- */}
              <h3 className="pf-sec"><span>1</span>Volume — quanto foi resolvido e por quem</h3>
              <div className="pf-grid pf-grid-vol">
                <Card title={volume.byMonth ? 'Solucionados por mês' : 'Solucionados por dia'} hint="Dia da solução (sem solução registrada: dia do fechamento)">
                  <Columns points={volume.points} />
                </Card>
                <Card title="Tickets fechados por técnico" hint="Ticket com 2 técnicos conta para os dois">
                  <HBars tone="qty" fmt={v => String(v)} rows={techRows.map(r => ({
                    id: r.id, label: r.name, value: r.n,
                    tip: <><b>{r.name}</b><br />{r.n} ticket(s): {r.solved} solucionado(s), {r.closed} fechado(s)<br />{r.par} atendido(s) em paralelo</>,
                  }))} />
                </Card>
              </div>

              {/* ---------- 2. tempos ---------- */}
              <h3 className="pf-sec"><span>2</span>Tempos — quanto demora para começar e para resolver</h3>
              <p className="pf-note">
                <b>Para iniciar</b> = da abertura até o ticket ser assumido por um técnico. <b>Para solução</b> = da abertura até a solução.
                {mode === 'util' ? ' Horário útil = calendário do SLA no ITSM, sem o tempo Pendente.' : ' Tempo corrido = 24×7, inclui Pendente.'}
                {noTake > 0 && <> {noTake} ticket(s) sem registro de quando foram assumidos ficam fora da média de início.</>}
              </p>
              <div className="pf-grid pf-grid-2">
                <Card title="Tempo médio para iniciar o atendimento" hint={`Por técnico · ${modeNote}`} tone="tto">
                  <HBars tone="tto" fmt={d} rows={techRows.filter(r => r.ttoAvg !== null).sort((a, b) => b.ttoAvg! - a.ttoAvg!).map(r => ({
                    id: r.id, label: r.name, value: r.ttoAvg!,
                    tip: <><b>{r.name}</b><br />média {d(r.ttoAvg)} · mediana {d(r.ttoMed)}<br />{r.ttoN} ticket(s) com início registrado</>,
                  }))} />
                </Card>
                <Card title="Tempo médio para solução" hint={`Por técnico · ${modeNote}`} tone="ttr">
                  <HBars tone="ttr" fmt={d} rows={techRows.filter(r => r.ttrAvg !== null).sort((a, b) => b.ttrAvg! - a.ttrAvg!).map(r => ({
                    id: r.id, label: r.name, value: r.ttrAvg!,
                    tip: <><b>{r.name}</b><br />média {d(r.ttrAvg)} · mediana {d(r.ttrMed)}<br />{r.ttrN} ticket(s)</>,
                  }))} />
                </Card>
              </div>
              <Card title="Resumo por técnico" hint="Mesmos números dos gráficos acima, em tabela">
                <div className="table-wrap">
                  <table className="grid pf-table">
                    <thead>
                      <tr>
                        <th className="left">Técnico</th><th>Tickets</th><th>Solucionados</th><th>Fechados</th>
                        <th className="pf-th-tto">Início · média</th><th className="pf-th-tto">Início · mediana</th>
                        <th className="pf-th-ttr">Solução · média</th><th className="pf-th-ttr">Solução · mediana</th><th>Em paralelo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {techRows.map(r => (
                        <tr key={r.id}>
                          <td className="left strong">{r.name}</td><td>{r.n}</td><td>{r.solved}</td><td>{r.closed}</td>
                          <td>{d(r.ttoAvg)}</td><td>{d(r.ttoMed)}</td><td>{d(r.ttrAvg)}</td><td>{d(r.ttrMed)}</td>
                          <td className={r.par ? '' : 'zero'}>{r.par}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {/* ---------- 3. destaques ---------- */}
              <h3 className="pf-sec"><span>3</span>Tickets em destaque — os extremos do período</h3>
              <div className="pf-grid pf-grid-3">
                <Card title="Mais demorados para iniciar" hint={`Top 10 · ${modeNote}`} tone="tto">
                  <Rank list={slowTto} kind="tto" mode={mode} fmt={d} techs={techList} />
                </Card>
                <Card title="Mais demorados para solucionar" hint={`Top 10 · ${modeNote}`} tone="ttr">
                  <Rank list={slowTtr} kind="ttr" mode={mode} fmt={d} techs={techList} />
                </Card>
                <Card title="Resolvidos mais rapidamente" hint={`Top 10 · da abertura à solução · ${modeNote}`} tone="ttr">
                  <Rank list={fastTtr} kind="ttr" mode={mode} fmt={d} techs={techList} fast />
                </Card>
              </div>

              {/* ---------- 4. paralelo ---------- */}
              <h3 className="pf-sec"><span>4</span>Atendimento em paralelo — mesma empresa, ao mesmo tempo</h3>
              <p className="pf-note">
                Dois tickets da mesma empresa estão <b>em paralelo</b> quando ficaram em atendimento ao mesmo tempo (de quando foram assumidos até a solução, tempo corrido). Considera os tickets resolvidos no período.
              </p>
              {par.length === 0 ? <p className="empty">Nenhum atendimento em paralelo na mesma empresa no período.</p> : (
                <div className="pf-grid pf-grid-par">
                  <Card title="Empresas com tickets em paralelo" hint="Tickets que ficaram em atendimento junto com outro da mesma empresa · clique para detalhar">
                    <HBars tone="par" fmt={v => String(v)} picked={picked?.entity ?? null} onPick={id => { setPickedEntity(String(id)); setShowClusters(12) }}
                      rows={par.map(e => ({
                        id: e.entity, label: shortEntity(e.entity), value: e.items.length,
                        tip: <><b>{e.entity}</b><br />{e.items.length} de {e.total} ticket(s) em paralelo ({pct(e.items.length, e.total)})<br />pico: {e.peak} ao mesmo tempo<br />Técnicos: {techList(e.techs)}</>,
                      }))} />
                  </Card>
                  {picked && <EntityDetail key={picked.entity} e={picked} axis={axis} techName={techName} limit={showClusters} onMore={() => setShowClusters(n => n + 20)} />}
                </div>
              )}
            </>}
          </>
        )}
      </section>
      {tip && (
        <div className="pf-tip" role="tooltip" style={{ left: Math.min(tip.x + 14, window.innerWidth - 300), top: tip.y + 14 }}>{tip.body}</div>
      )}
    </TipCtx.Provider>
  )
}

/* ---------- componentes dos gráficos ---------- */

function Card({ title, hint, tone, children }: { title: string; hint?: string; tone?: 'tto' | 'ttr'; children: ReactNode }) {
  return (
    <section className={`pf-card${tone ? ' ' + tone : ''}`}>
      <header><h4>{tone && <i className={`pf-key ${tone}`} aria-hidden />}{title}</h4>{hint && <p>{hint}</p>}</header>
      {children}
    </section>
  )
}

interface BarRow { id: string | number; label: string; value: number; tip: ReactNode }
function HBars({ rows, tone, fmt, onPick, picked }: { rows: BarRow[]; tone: 'tto' | 'ttr' | 'qty' | 'par'; fmt: (v: number) => string; onPick?: (id: string | number) => void; picked?: string | null }) {
  const setTip = useContext(TipCtx)
  if (!rows.length) return <p className="empty">Sem dados.</p>
  const max = Math.max(...rows.map(r => r.value), 0)
  return (
    <div className="pf-hbars">
      {rows.map(r => {
        const inner = <>
          <span className="pf-hbar-label" title={r.label}>{r.label}</span>
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

function Columns({ points }: { points: { key: string; label: string; long: string; value: number }[] }) {
  const setTip = useContext(TipCtx)
  const max = Math.max(1, ...points.map(p => p.value))
  const nice = max <= 4 ? max : Math.ceil(max / 4) * 4
  const peak = points.reduce((b, p) => (p.value > (b?.value ?? -1) ? p : b), points[0])
  const every = Math.max(1, Math.ceil(points.length / 12))
  const total = points.reduce((s, p) => s + p.value, 0)
  return (
    <div className="pf-cols">
      <div className="pf-cols-y" aria-hidden>{[nice, nice / 2, 0].map(v => <span key={v}>{Number.isInteger(v) ? v : v.toFixed(1)}</span>)}</div>
      <div className="pf-cols-body">
        <div className="pf-cols-plot" role="img" aria-label={`${total} tickets no período; maior volume ${peak?.value ?? 0} em ${peak?.long ?? ''}`}>
          <i className="pf-grid-line" style={{ bottom: '50%' }} /><i className="pf-grid-line" style={{ bottom: '100%' }} />
          {points.map(p => (
            <div key={p.key} className="pf-col" {...tipProps(setTip, () => <><b>{p.long}</b><br />{p.value} ticket(s)</>)}>
              {p === peak && p.value > 0 && <span className="pf-col-val">{p.value}</span>}
              <span className="pf-col-fill" style={{ height: `${(p.value / nice) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="pf-cols-x" aria-hidden>{points.map((p, i) => <span key={p.key}>{i % every === 0 ? p.label : ''}</span>)}</div>
      </div>
    </div>
  )
}

function Rank({ list, kind, mode, fmt, techs, fast }: { list: Item[]; kind: 'tto' | 'ttr'; mode: Mode; fmt: (s: number | null) => string; techs: (ids: number[]) => string; fast?: boolean }) {
  if (!list.length) return <p className="empty">Sem dados.</p>
  const max = Math.max(...list.map(i => i[kind][mode] ?? 0))
  return (
    <ol className="pf-rank">
      {list.map((it, i) => {
        const v = it[kind][mode]
        return (
          <li key={it.t.id}>
            <span className="pf-rank-n">{i + 1}</span>
            <div className="pf-rank-body">
              <div className="pf-rank-top">
                <a href={it.t.url} target="_blank" rel="noreferrer" className="id">#{it.t.id}</a>
                <span className="pf-rank-title" title={it.t.title}>{it.t.title}</span>
                <b className="pf-rank-val">{fmt(v)}</b>
              </div>
              <div className="pf-rank-meta" title={it.t.entity ?? ''}>{shortEntity(it.t.entity)} · {techs(it.techs)}</div>
              {!fast && <span className="pf-rank-bar"><span className={`pf-fill ${kind}`} style={{ '--p': max ? (v ?? 0) / max : 0 } as React.CSSProperties} /></span>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

const shortDt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' })
const iso = (t: number) => new Date(t).toISOString()

/** Detalhe de uma empresa: momento de pico (quem estava em quais tickets) + linha do tempo do período. */
function EntityDetail({ e, axis, techName, limit, onMore }: { e: EntityPar; axis: [number, number]; techName: (id: number) => string; limit: number; onMore: () => void }) {
  const setTip = useContext(TipCtx)
  const [a0, a1] = axis
  const span = Math.max(1, a1 - a0)
  const clip = (t: number) => Math.min(a1, Math.max(a0, t))
  const x = (t: number) => `${((clip(t) - a0) / span) * 100}%`
  const w = (a: number, b: number) => `${Math.max(0.5, ((clip(b) - clip(a)) / span) * 100)}%`
  const names = (ids: number[]) => ids.map(techName).join(', ')
  // marcas de dia no eixo (até ~8 rótulos)
  const days = Math.round(span / 864e5)
  const step = Math.max(1, Math.ceil(days / 8))
  const ticks: number[] = []
  if (days > 1) for (let i = 0; i <= days; i += step) { const d = new Date(a0); d.setDate(d.getDate() + i); ticks.push(d.getTime()) }
  const sameTech = e.techs.length === 1
  const [allPeak, setAllPeak] = useState(false)
  // quantos tickets cada técnico tinha em atendimento no momento do pico
  const peakTechs = [...e.peakItems.flatMap(i => i.techs).reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<number, number>())]
    .sort((a, b) => b[1] - a[1])
  return (
    <article className="pf-card pf-entity">
      <header className="pf-ent-head">
        <div>
          <h4 title={e.entity}>{shortEntity(e.entity)}</h4>
          <p>{e.items.length} de {e.total} ticket(s) em paralelo · {dur(e.overlapSec)} com 2+ tickets em atendimento</p>
        </div>
        <span className={`pill${sameTech ? '' : ' warn'}`}>{sameTech ? 'mesmo técnico' : `${e.techs.length} técnicos`}</span>
      </header>
      <p className="pf-cl-techs">Técnicos envolvidos: <b>{names(e.techs)}</b></p>

      <div className="pf-peak">
        <div className="pf-peak-head"><b>Pico: {e.peak} tickets ao mesmo tempo</b><span>{formatDate(iso(e.peakAt))}</span></div>
        <div className="pf-peak-techs">
          {peakTechs.map(([id, n]) => <span key={id} className="pf-chip">{techName(id)} <b>{n}</b></span>)}
        </div>
        <ul>
          {(allPeak ? e.peakItems : e.peakItems.slice(0, 6)).map(it => (
            <li key={it.t.id}>
              <a href={it.t.url} target="_blank" rel="noreferrer" className="id">#{it.t.id}</a>
              <span className="pf-peak-title" title={it.t.title}>{it.t.title}</span>
              <span className="pf-peak-tech">{names(it.techs)}</span>
            </li>
          ))}
        </ul>
        {e.peakItems.length > 6 && <button type="button" className="link" onClick={() => setAllPeak(v => !v)}>{allPeak ? 'mostrar menos' : `ver os ${e.peakItems.length} tickets do pico`}</button>}
      </div>

      <h5 className="pf-sub">Linha do tempo no período <span>barra = do início do atendimento à solução · faixa sombreada = 2+ tickets ao mesmo tempo</span></h5>
      <div className="pf-gantt">
        {e.items.slice(0, limit).map(it => (
          <div key={it.t.id} className="pf-g-row">
            <div className="pf-g-label">
              <a href={it.t.url} target="_blank" rel="noreferrer" className="id">#{it.t.id}</a>
              <span title={it.t.title}>{it.t.title}</span>
            </div>
            <div className="pf-g-track">
              {e.windows.filter(([a, b]) => b > a0 && a < a1).map(([a, b]) => <i key={a} className="pf-g-win" style={{ left: x(a), width: w(a, b) }} />)}
              <span className={`pf-g-bar${it.startMs < a0 ? ' cut' : ''}`} style={{ left: x(it.startMs), width: w(it.startMs, it.endMs) }}
                {...tipProps(setTip, () => <><b>#{it.t.id}</b> {it.t.title}<br />Técnico: {names(it.techs)}<br />Início do atendimento: {formatDate(iso(it.startMs))}{it.startMs < a0 && ' (antes do período)'}<br />Solução: {formatDate(iso(it.endMs))}</>)} />
            </div>
            <span className="pf-g-tech" title={names(it.techs)}>{names(it.techs)}</span>
          </div>
        ))}
        <div className="pf-g-axis" aria-hidden>
          <span />
          <div className="pf-g-ticks">{ticks.length ? ticks.map(t => <span key={t} style={{ left: x(t) }}>{dayFmt.format(t)}</span>) : <><span style={{ left: 0 }}>{shortDt.format(a0)}</span><span style={{ left: '100%' }}>{shortDt.format(a1)}</span></>}</div>
        </div>
      </div>
      {e.items.length > limit && <button type="button" className="pf-more" onClick={onMore}>Mostrar mais {Math.min(20, e.items.length - limit)} de {e.items.length - limit} ticket(s)</button>}
    </article>
  )
}

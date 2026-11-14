import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { SlaReportResponse, SlaReportTicket } from '../types'
import { apiUrl, formatDate } from '../format'
import { NO_ENTITY, shortEntity } from '../entity'

type ReportId = 'ttr' | 'tto' | 'tempo'
const REPORTS: { id: ReportId; label: string; title: string; help: string }[] = [
  {
    id: 'ttr', label: 'Atendidos no prazo · solução estourou', title: 'Atendidos no prazo com solução estourada',
    help: 'Tickets assumidos dentro do prazo de atendimento cujo prazo de solução estourou (solucionados depois do prazo, ou ainda abertos com o prazo vencido). Base: tickets com SLA de solução.',
  },
  {
    id: 'tto', label: 'Atendidos fora do prazo', title: 'Atendidos fora do prazo',
    help: 'Tickets com o prazo de atendimento estourado: assumidos depois do prazo, ou ainda não assumidos com o prazo vencido. Base: tickets com SLA de atendimento.',
  },
  {
    id: 'tempo', label: 'Tempo em atendimento', title: 'Tempo em atendimento por ticket',
    help: 'Do momento em que o ticket foi assumido até a solução (ou até agora, se aberto). "Útil" = horário comercial do calendário do SLA, sem o tempo Pendente (estatística do ITSM, só para solucionados). "Corrido" = 24×7.',
  },
]
const PERIODS = [1, 3, 6, 12]
const NO_TECH = -1
const pad = (n: number) => String(n).padStart(2, '0')
const curMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }
const shiftMonth = (m: string, delta: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y!, mo! - 1 + delta, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthLabel = (ym: string) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`))
const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null)

/** Duração em segundos → "3d 4h", "5h 20min", "12 min". */
function dur(sec: number | null | undefined, hoursOnly = false): string {
  if (sec === null || sec === undefined) return '—'
  const s = Math.max(0, sec)
  if (s < 3600) return `${Math.max(s ? 1 : 0, Math.round(s / 60))} min`
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
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
const isSolved = (t: SlaReportTicket) => t.status === 5 || t.status === 6

interface Calc {
  t: SlaReportTicket
  hasTto: boolean; hasTtr: boolean
  ttoOk: boolean                 // assumido dentro do prazo
  ttoLateBy: number | null       // s (assumido ou agora − prazo)
  ttrLateBy: number | null       // s (solução ou agora − prazo)
  startMs: number | null         // início do atendimento
  wallSec: number | null         // corrido
  bizSec: number | null          // útil (ITSM)
}

function calc(t: SlaReportTicket, now: number): Calc {
  const taken = (t.takeDelaySec ?? 0) > 0
  const ttoDue = ms(t.ttoDueUtc), ttrDue = ms(t.ttrDueUtc)
  const takenAt = ms(t.takenAtUtc), solvedAt = ms(t.solvedAtUtc), opened = ms(t.openedAtUtc)
  const startMs = taken ? takenAt ?? opened : isSolved(t) ? opened : null
  const endMs = isSolved(t) ? solvedAt : now
  return {
    t,
    hasTto: ttoDue !== null, hasTtr: ttrDue !== null,
    ttoOk: ttoDue !== null && taken && !t.ttoLate,
    ttoLateBy: t.ttoLate && ttoDue !== null ? (taken ? takenAt ?? now : now) - ttoDue : null,
    ttrLateBy: t.ttrLate && ttrDue !== null ? (solvedAt ?? now) - ttrDue : null,
    startMs,
    wallSec: startMs !== null && endMs !== null ? Math.max(0, (endMs - startMs) / 1000) : null,
    bizSec: isSolved(t) && t.solveDelaySec !== null ? Math.max(0, t.solveDelaySec - (t.takeDelaySec ?? 0)) : null,
  }
}

interface Props {
  filter: string
  entitySel: Set<string> | null
  techSel: Set<number> | null
}

export default function SlaReportsView({ filter, entitySel, techSel }: Props) {
  const [report, setReport] = useState<ReportId>(() => { try { const v = localStorage.getItem('slaReport.id'); return REPORTS.some(r => r.id === v) ? v as ReportId : 'ttr' } catch { return 'ttr' } })
  const [months, setMonths] = useState(() => { try { const v = Number(localStorage.getItem('slaReport.months')); return PERIODS.includes(v) ? v : 1 } catch { return 1 } })
  const [to, setTo] = useState(curMonth)
  const [data, setData] = useState<SlaReportResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<number>>(new Set())
  const from = shiftMonth(to, -(months - 1))

  useEffect(() => { try { localStorage.setItem('slaReport.id', report) } catch { /* sem storage */ } }, [report])
  useEffect(() => { try { localStorage.setItem('slaReport.months', String(months)) } catch { /* sem storage */ } }, [months])

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(apiUrl(`/api/reports/sla?from=${from}&to=${to}${refresh ? '&refresh=true' : ''}`), { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
      setData(body as SlaReportResponse)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { void load(false) }, [load])

  const rep = data?.report ?? null
  const now = useMemo(() => Date.now(), [rep]) // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => new Map((rep?.technicians ?? []).map(t => [t.id, t.name])), [rep])
  const techName = (id: number) => (id === NO_TECH ? 'Sem técnico' : names.get(id) ?? `Usuário #${id}`)

  // tickets filtrados (texto / entidade) e agrupados por técnico (ticket com 2 técnicos conta para os dois)
  const groups = useMemo(() => {
    if (!rep) return []
    const q = filter.trim().toLowerCase()
    const byTech = new Map<number, Calc[]>()
    for (const t of rep.tickets) {
      if (entitySel !== null && !entitySel.has(t.entity ?? NO_ENTITY)) continue
      const techs = t.techIds.length ? t.techIds : [NO_TECH]
      if (q && !`#${t.id} ${t.title} ${t.entity ?? ''} ${techs.map(techName).join(' ')}`.toLowerCase().includes(q)) continue
      const c = calc(t, now)
      for (const id of techs) {
        if (techSel !== null && !techSel.has(id)) continue
        if (!byTech.has(id)) byTech.set(id, [])
        byTech.get(id)!.push(c)
      }
    }
    return [...byTech.entries()].map(([id, list]) => ({ id, name: techName(id), list }))
  }, [rep, filter, entitySel, techSel, now]) // eslint-disable-line react-hooks/exhaustive-deps

  const def = REPORTS.find(r => r.id === report)!

  // linhas do relatório escolhido
  const rows = useMemo(() => groups.map(g => {
    if (report === 'ttr') {
      const base = g.list.filter(c => c.hasTtr)
      const ok = base.filter(c => c.ttoOk)
      const hit = ok.filter(c => c.t.ttrLate).sort((a, b) => (b.ttrLateBy ?? 0) - (a.ttrLateBy ?? 0))
      return { ...g, base: base.length, ok: ok.length, hit, avgLate: avg(hit.map(c => (c.ttrLateBy ?? 0) / 1000)) }
    }
    if (report === 'tto') {
      const base = g.list.filter(c => c.hasTto)
      const hit = base.filter(c => c.t.ttoLate).sort((a, b) => (b.ttoLateBy ?? 0) - (a.ttoLateBy ?? 0))
      return { ...g, base: base.length, ok: base.length - hit.length, hit, avgLate: avg(hit.map(c => (c.ttoLateBy ?? 0) / 1000)) }
    }
    const hit = g.list.filter(c => c.startMs !== null).sort((a, b) => (b.bizSec ?? b.wallSec ?? 0) - (a.bizSec ?? a.wallSec ?? 0))
    const biz = hit.map(c => c.bizSec).filter((x): x is number => x !== null)
    return {
      ...g, base: g.list.length, ok: hit.filter(c => isSolved(c.t)).length, hit,
      avgBiz: avg(biz), medBiz: median(biz), avgWall: avg(hit.filter(c => isSolved(c.t)).map(c => c.wallSec ?? 0)),
      action: hit.reduce((s, c) => s + (c.t.actionTimeSec ?? 0), 0),
    }
  }).filter(r => report === 'tempo' ? r.hit.length > 0 : r.base > 0)
    .sort((a, b) => b.hit.length - a.hit.length || a.name.localeCompare(b.name)), [groups, report])

  // totais (tickets únicos)
  const uniq = <T extends { t: SlaReportTicket }>(xs: T[]) => [...new Map(xs.map(x => [x.t.id, x])).values()]
  const allBase = uniq(groups.flatMap(g => g.list))
  const allHit = uniq(rows.flatMap(r => r.hit))
  const kpis = (() => {
    if (report === 'ttr') {
      const base = allBase.filter(c => c.hasTtr), ok = base.filter(c => c.ttoOk)
      return [
        { v: base.length, l: 'Tickets com SLA de solução', tone: 'gray' },
        { v: ok.length, l: 'Atendidos no prazo', tone: 'green' },
        { v: allHit.length, l: 'Desses, solução estourou', tone: 'red', sub: pct(allHit.length, ok.length) + ' dos atendidos no prazo' },
        { v: dur(avg(allHit.map(c => (c.ttrLateBy ?? 0) / 1000))), l: 'Estouro médio da solução', tone: 'amber' },
      ]
    }
    if (report === 'tto') {
      const base = allBase.filter(c => c.hasTto)
      return [
        { v: base.length, l: 'Tickets com SLA de atendimento', tone: 'gray' },
        { v: allHit.length, l: 'Atendidos fora do prazo', tone: 'red', sub: pct(allHit.length, base.length) + ' do total' },
        { v: allHit.filter(c => (c.t.takeDelaySec ?? 0) <= 0).length, l: 'Ainda não assumidos', tone: 'amber' },
        { v: dur(avg(allHit.map(c => (c.ttoLateBy ?? 0) / 1000))), l: 'Atraso médio no atendimento', tone: 'amber' },
      ]
    }
    const biz = allHit.map(c => c.bizSec).filter((x): x is number => x !== null)
    return [
      { v: allHit.length, l: 'Tickets em/com atendimento', tone: 'gray' },
      { v: allHit.filter(c => !isSolved(c.t)).length, l: 'Ainda em atendimento', tone: 'blue' },
      { v: dur(avg(biz), true), l: 'Média útil (solucionados)', tone: 'green', sub: `mediana ${dur(median(biz), true)}` },
      { v: dur(allHit.reduce((s, c) => s + (c.t.actionTimeSec ?? 0), 0), true), l: 'Tempo lançado em tarefas', tone: 'amber' },
    ]
  })()

  const toggle = (id: number) => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allOpen = rows.length > 0 && rows.every(r => open.has(r.id))

  const exportCsv = () => {
    const esc = (s: string | number | null | undefined) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const date = (iso: string | null) => (iso ? formatDate(iso) : '')
    const head = report === 'tempo'
      ? ['Técnico', 'Ticket', 'Título', 'Entidade', 'Status', 'Abertura', 'Assumido', 'Solucionado', 'Útil (h)', 'Corrido (h)', 'Pendente (h)', 'Lançado (h)']
      : ['Técnico', 'Ticket', 'Título', 'Entidade', 'Status', 'SLA', 'Prazo', report === 'ttr' ? 'Solucionado' : 'Assumido', 'Estouro (h)']
    const h = (s: number | null | undefined) => (s === null || s === undefined ? '' : (s / 3600).toFixed(2).replace('.', ','))
    const lines = [head.map(esc).join(';')]
    for (const r of rows) for (const c of r.hit) {
      const t = c.t
      lines.push((report === 'tempo'
        ? [r.name, t.id, t.title, shortEntity(t.entity), t.statusLabel, date(t.openedAtUtc), date(c.startMs ? new Date(c.startMs).toISOString() : null), date(t.solvedAtUtc), h(c.bizSec), h(c.wallSec), h(t.waitingSec), h(t.actionTimeSec)]
        : report === 'ttr'
          ? [r.name, t.id, t.title, shortEntity(t.entity), t.statusLabel, t.ttrName, date(t.ttrDueUtc), date(t.solvedAtUtc), h((c.ttrLateBy ?? 0) / 1000)]
          : [r.name, t.id, t.title, shortEntity(t.entity), t.statusLabel, t.ttoName, date(t.ttoDueUtc), date(t.takenAtUtc), h((c.ttoLateBy ?? 0) / 1000)]
      ).map(esc).join(';'))
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `sla-${report}-${from}${from === to ? '' : '_' + to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const colCount = report === 'tempo' ? 8 : 6

  return (
    <section className="panel">
      <header className="panel-head row">
        <div>
          <h2>{def.title}</h2>
          <p>
            Tickets abertos em <b>{from === to ? monthLabel(to) : `${monthLabel(from)} a ${monthLabel(to)}`}</b> · por técnico atribuído (ticket com 2 técnicos conta para os dois)
            {rep && <> · Gerado em {formatDate(rep.generatedAtUtc)} ({(rep.durationMs / 1000).toFixed(1)}s)</>}
          </p>
        </div>
        <div className="actions">
          <div className="seg" role="group" aria-label="Mês final">
            <button type="button" onClick={() => setTo(m => shiftMonth(m, -1))} aria-label="Mês anterior">‹</button>
            <input type="month" className="sr-month" value={to} max={curMonth()} onChange={e => e.target.value && setTo(e.target.value)} aria-label="Mês" />
            <button type="button" onClick={() => setTo(m => shiftMonth(m, 1))} disabled={to >= curMonth()} aria-label="Próximo mês">›</button>
          </div>
          <div className="seg" role="group" aria-label="Período">
            {PERIODS.map(p => <button key={p} type="button" className={months === p ? 'on' : ''} aria-pressed={months === p} onClick={() => setMonths(p)}>{p === 1 ? '1 mês' : `${p} meses`}</button>)}
          </div>
          <button type="button" onClick={exportCsv} disabled={!rows.length}>Exportar CSV</button>
          <button type="button" className="primary" onClick={() => load(true)} disabled={loading}>{loading ? 'Carregando…' : '⟳ Atualizar'}</button>
        </div>
      </header>

      <div className="seg sr-tabs" role="tablist" aria-label="Relatório">
        {REPORTS.map(r => <button key={r.id} type="button" role="tab" aria-selected={report === r.id} className={report === r.id ? 'on' : ''} onClick={() => setReport(r.id)}>{r.label}</button>)}
      </div>
      <p className="sr-help">{def.help}</p>

      {error && <div className="banner error">Falha ao gerar o relatório: {error}</div>}
      {data?.error && <div className="banner error">Falha ao consultar o ITSM: {data.error}{rep && ' — exibindo o último relatório gerado.'}</div>}
      {data?.throttledSeconds && <div className="banner info">Atualização limitada a 1 a cada {data.throttledSeconds}s — exibindo o último relatório.</div>}
      {rep?.warnings.map(w => <div key={w} className="banner warn">{w}</div>)}
      {!rep && loading && <p className="empty center">Gerando relatório…</p>}

      {rep && (
        <>
          <section className="kpis">
            {kpis.map(k => (
              <div key={k.l} className={`kpi tone-${k.tone}`}>
                <span className="kpi-value">{k.v}</span><span className="kpi-label">{k.l}</span>{k.sub && <span className="kpi-sub">{k.sub}</span>}
              </div>
            ))}
          </section>
          <div className="table-wrap report">
            <table className="grid sr-grid">
              <thead>
                <tr>
                  <th className="left">
                    <button type="button" className="link" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map(r => r.id)))}>{allOpen ? '▾ recolher' : '▸ expandir'}</button> Técnico
                  </th>
                  {report === 'ttr' && <><th>Com SLA de solução</th><th>Atendidos no prazo</th><th>Solução estourou</th><th>% dos atend. no prazo</th><th>Estouro médio</th></>}
                  {report === 'tto' && <><th>Com SLA de atendimento</th><th>No prazo</th><th>Fora do prazo</th><th>% fora do prazo</th><th>Atraso médio</th></>}
                  {report === 'tempo' && <><th>Tickets</th><th>Solucionados</th><th title="Horário útil, sem tempo Pendente">Média útil</th><th title="Horário útil, sem tempo Pendente">Mediana útil</th><th title="24×7, solucionados">Média corrida</th><th>Lançado em tarefas</th><th>Maior (útil)</th></>}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const isOpen = open.has(r.id)
                  return (
                    <Fragment key={r.id}>
                      <tr className={`sr-row${isOpen ? ' open' : ''}`} onClick={() => toggle(r.id)} aria-expanded={isOpen}>
                        <td className="left strong"><span className="sr-caret">{isOpen ? '▾' : '▸'}</span>{r.name}</td>
                        {report === 'ttr' && <><td>{r.base}</td><td>{r.ok}</td><td className={r.hit.length ? 'sr-bad' : 'zero'}>{r.hit.length}</td><td>{pct(r.hit.length, r.ok)}</td><td>{'avgLate' in r ? dur(r.avgLate) : ''}</td></>}
                        {report === 'tto' && <><td>{r.base}</td><td>{r.ok}</td><td className={r.hit.length ? 'sr-bad' : 'zero'}>{r.hit.length}</td><td>{pct(r.hit.length, r.base)}</td><td>{'avgLate' in r ? dur(r.avgLate) : ''}</td></>}
                        {report === 'tempo' && 'avgBiz' in r && <>
                          <td>{r.hit.length}</td><td>{r.ok}</td><td>{dur(r.avgBiz, true)}</td><td>{dur(r.medBiz, true)}</td><td>{dur(r.avgWall)}</td><td>{dur(r.action, true)}</td>
                          <td>{dur(Math.max(0, ...r.hit.map(c => c.bizSec ?? 0)) || null, true)}</td>
                        </>}
                      </tr>
                      {isOpen && (
                        <tr className="sr-detail">
                          <td colSpan={colCount}>
                            {r.hit.length === 0 ? <p className="empty">Nenhum ticket neste critério. 🎉</p> : <TicketTable report={report} list={r.hit} />}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                {rows.length === 0 && <tr><td colSpan={colCount} className="empty">Nenhum ticket no período com os filtros atuais.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function TicketTable({ report, list }: { report: ReportId; list: Calc[] }) {
  return (
    <table className="grid sr-tickets">
      <thead>
        <tr>
          <th className="left">Ticket</th><th className="left">Título</th><th className="left">Entidade</th><th className="left">Status</th>
          {report === 'ttr' && <><th className="left">SLA de solução</th><th>Prazo</th><th>Solucionado</th><th>Estourou</th></>}
          {report === 'tto' && <><th className="left">SLA de atendimento</th><th>Prazo</th><th>Assumido</th><th>Atraso</th></>}
          {report === 'tempo' && <><th>Assumido</th><th>Solucionado</th><th title="Horário útil, sem tempo Pendente">Útil</th><th title="24×7">Corrido</th><th>Pendente</th><th>Lançado</th></>}
        </tr>
      </thead>
      <tbody>
        {list.map(c => {
          const t = c.t
          return (
            <tr key={t.id}>
              <td className="left"><a href={t.url} target="_blank" rel="noreferrer">#{t.id}</a></td>
              <td className="left title" title={t.title}>{t.title}</td>
              <td className="left" title={t.entity ?? ''}>{shortEntity(t.entity)}</td>
              <td className="left">{t.statusLabel}</td>
              {report === 'ttr' && <>
                <td className="left">{t.ttrName ?? '—'}</td><td>{formatDate(t.ttrDueUtc)}</td>
                <td>{t.solvedAtUtc ? formatDate(t.solvedAtUtc) : <span className="pill warn">em aberto</span>}</td>
                <td className="sr-bad">{dur((c.ttrLateBy ?? 0) / 1000)}</td>
              </>}
              {report === 'tto' && <>
                <td className="left">{t.ttoName ?? '—'}</td><td>{formatDate(t.ttoDueUtc)}</td>
                <td>{(t.takeDelaySec ?? 0) > 0 ? formatDate(t.takenAtUtc) : <span className="pill warn">não assumido</span>}</td>
                <td className="sr-bad">{dur((c.ttoLateBy ?? 0) / 1000)}</td>
              </>}
              {report === 'tempo' && <>
                <td>{c.startMs ? formatDate(new Date(c.startMs).toISOString()) : '—'}</td>
                <td>{t.solvedAtUtc && isSolved(t) ? formatDate(t.solvedAtUtc) : <span className="pill">em atendimento</span>}</td>
                <td className="strong">{dur(c.bizSec, true)}</td><td>{dur(c.wallSec)}</td><td>{t.waitingSec ? dur(t.waitingSec, true) : '—'}</td><td>{t.actionTimeSec ? dur(t.actionTimeSec, true) : '—'}</td>
              </>}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

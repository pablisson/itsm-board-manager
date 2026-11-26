import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CancelKind, ClientReportResponse, ClientTicket } from '../types'
import { apiUrl, formatDate, formatDuration } from '../format'
import { NO_ENTITY, shortEntity } from '../entity'
import { Card, HBars, TipBox } from './vizKit'
import { addDays, fmtDay, TipCtx, tipProps, ymd, type Tip } from './vizCore'

/* ---------- parâmetros ---------- */
const DAYS = [7, 15, 30, 60, 90] as const
const AGES = [3, 5, 7, 15, 30] as const     // sem SLA: atraso após N dias abertos
const STALES = [3, 5, 7, 15] as const       // parado: sem atualização há N dias
const DUP_WINDOW_H = 72                     // possíveis duplicados: abertos com até 72 h de diferença
const RECUR_MIN = 3                         // problema recorrente: 3+ tickets do mesmo problema no cliente
const H = 36e5

/** Peso de cada sinal no índice de risco (explicado na tela). */
const W = { overdue: 3, stale: 2, unassigned: 2, reopened: 2, respLate: 1, net: 1, recurring: 1, dup: 1 }
const LEVEL = { crit: 50, warn: 15 }        // calibrado com a distribuição real (15 e 30 dias)

const CANCEL_LABEL: Record<CancelKind, string> = {
  duplicidade: 'Duplicidade', sem_retorno: 'Sem retorno do cliente', solicitante: 'Pelo solicitante', atendimento: 'Pelo atendimento',
}

function readNum<T extends number>(key: string, allowed: readonly T[], def: T): T {
  try { const v = Number(localStorage.getItem(key)); return (allowed as readonly number[]).includes(v) ? v as T : def } catch { return def }
}
const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null)
const dayOf = (iso: string | null) => (iso ? ymd(new Date(iso)) : null)
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
const hrs = (sec: number | null | undefined) => (sec ? sec / 3600 : null)
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
const parts = (c: string | null | undefined) => (c ? c.split('>').map(s => s.trim()).filter(Boolean) : [])

/** Problema = categoria completa a partir do 2º nível (o 1º nível sozinho é genérico demais). */
const problemOf = (t: ClientTicket) => (parts(t.category).length >= 2 ? parts(t.category).join(' › ') : null)

const STOP = new Set('para com sem dos das nos nas uma por que não nao foi esta está como mais pelo pela the and for'.split(' '))
const tokens = (s: string) => new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^(re|fw|enc|fwd|res)\s*:\s*/g, '')
  .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)))
function similar(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0
  let i = 0; for (const w of a) if (b.has(w)) i++
  return i / (a.size + b.size - i)
}

/* ---------- linha derivada ---------- */
interface Row {
  t: ClientTicket; entity: string
  overdue: 'sla' | 'idade' | null; lateH: number      // atraso (h) além do prazo; sem SLA, idade total
  stale: boolean; idleH: number; unassigned: boolean
  resp: number | null                                // tempo de resposta (h, horário útil) — só abertos no período
  waiting: boolean                                   // aberto no período e ainda não assumido
  respLate: boolean; respHasSla: boolean
  resolved: boolean; cancelled: boolean; reopened: boolean
  problem: string | null
}

interface DupPair { a: Row; b: Row; kind: 'marcado' | 'possivel'; score: number }

interface ClientStat {
  entity: string; rows: Row[]
  backlog: Row[]; overdue: Row[]; stale: Row[]; unassigned: Row[]; opened: Row[]; resolved: Row[]; cancelled: Row[]; reopened: Row[]
  respMedian: number | null; respN: number; respWithin: number; respWithSla: number; respLate: number; waiting: number
  net: number; recurring: [string, Row[]][]; dups: DupPair[]
  score: number; level: 'crit' | 'warn' | 'ok'; parts: [string, number][]
}

type SortKey = 'score' | 'entity' | 'overdue' | 'backlog' | 'opened' | 'resolved' | 'net' | 'resp' | 'respPct' | 'stale' | 'unassigned' | 'reopened' | 'dups' | 'cancelled'
type ListKey = 'overdue' | 'stale' | 'unassigned' | 'opened' | 'resolved' | 'cancelled' | 'reopened' | 'dups' | 'recurring'

interface Props { filter: string; entitySel: Set<string> | null; techSel: Set<number> | null }

export default function ClientView({ filter, entitySel, techSel }: Props) {
  const [days, setDays] = useState(() => readNum('cli.days', DAYS, 15))
  const [ageDays, setAgeDays] = useState(() => readNum('cli.age', AGES, 7))
  const [staleDays, setStaleDays] = useState(() => readNum('cli.stale', STALES, 5))
  const [data, setData] = useState<ClientReportResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip>(null)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'score', desc: true })
  const [limit, setLimit] = useState(15)
  const [picked, setPicked] = useState<string | null>(null)
  const [list, setList] = useState<ListKey>('overdue')
  const detailRef = useRef<HTMLDivElement>(null)

  useEffect(() => { try { localStorage.setItem('cli.days', String(days)); localStorage.setItem('cli.age', String(ageDays)); localStorage.setItem('cli.stale', String(staleDays)) } catch { /* sem storage */ } }, [days, ageDays, staleDays])

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(apiUrl(`/api/reports/clients?days=${days}${refresh ? '&refresh=true' : ''}`), { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
      setData(body as ClientReportResponse)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }, [days])
  useEffect(() => { void load(false) }, [load])

  const rep = data?.report ?? null
  const names = useMemo(() => new Map((rep?.people ?? []).map(p => [p.id, p.name])), [rep])
  const name = useCallback((id: number) => names.get(id) ?? `Usuário #${id}`, [names])
  const who = useCallback((ids: number[]) => (ids.length ? ids.map(name).join(', ') : '—'), [name])

  // tickets com os filtros do topo + sinais calculados
  const rows = useMemo<Row[]>(() => {
    if (!rep) return []
    const now = new Date(rep.generatedAtUtc).getTime()
    const q = filter.trim().toLowerCase()
    const out: Row[] = []
    for (const t of rep.tickets) {
      const entity = t.entity ?? NO_ENTITY
      if (entitySel !== null && !entitySel.has(entity)) continue
      if (techSel !== null && !t.techIds.some(id => techSel.has(id))) continue
      if (q && !`#${t.id} ${t.title} ${t.entity ?? ''} ${t.category ?? ''} ${who(t.techIds)} ${who(t.requesterIds)}`.toLowerCase().includes(q)) continue
      const opened = ms(t.openedAtUtc) ?? now
      const due = ms(t.ttrDueUtc)
      const ageH = (now - opened) / H
      let overdue: Row['overdue'] = null, lateH = 0
      // Pendente: o ITSM pausa o prazo de solução e o recalcula ao retomar (mesma regra do Board) → não conta como atraso
      if (t.inBacklog && t.status !== 4) {
        if (due !== null) { if (due < now) { overdue = 'sla'; lateH = (now - due) / H } }
        else if (ageH > ageDays * 24) { overdue = 'idade'; lateH = ageH }
      }
      const idleH = (now - (ms(t.updatedAtUtc) ?? opened)) / H
      const taken = (t.takeDelaySec ?? 0) > 0
      const waiting = t.inOpened && t.inBacklog && !taken && t.techIds.length === 0
      const ttoDue = ms(t.ttoDueUtc)
      out.push({
        t, entity, overdue, lateH,
        stale: t.inBacklog && idleH > staleDays * 24, idleH,
        unassigned: t.inBacklog && t.status <= 3 && t.techIds.length === 0,
        resp: t.inOpened && taken ? hrs(t.takeDelaySec) : null,
        waiting,
        respHasSla: t.inOpened && ttoDue !== null && (taken || waiting),
        respLate: t.inOpened && (t.ttoLate || (waiting && ttoDue !== null && ttoDue < now)),
        resolved: t.inSolved && !t.cancel,
        cancelled: t.inSolved && !!t.cancel,
        reopened: t.reopenedInPeriod > 0,
        problem: t.inOpened ? problemOf(t) : null,
      })
    }
    return out
  }, [rep, filter, entitySel, techSel, who, ageDays, staleDays])

  const clients = useMemo<ClientStat[]>(() => {
    const by = new Map<string, Row[]>()
    for (const r of rows) { const l = by.get(r.entity); if (l) l.push(r); else by.set(r.entity, [r]) }
    return [...by.entries()].map(([entity, rs]) => statOf(entity, rs))
  }, [rows])

  const sorted = useMemo(() => {
    const v = (c: ClientStat): number | string => {
      switch (sort.key) {
        case 'entity': return shortEntity(c.entity).toLowerCase()
        case 'resp': return c.respMedian ?? -1
        case 'respPct': return c.respWithSla ? pct(c.respWithin, c.respWithSla) : 101
        case 'dups': return c.dups.length
        case 'score': return c.score * 1000 + c.overdue.length
        case 'net': return c.net
        default: return c[sort.key].length
      }
    }
    return [...clients].sort((a, b) => { const x = v(a), y = v(b); const d = x < y ? -1 : x > y ? 1 : 0; return sort.desc ? -d : d })
  }, [clients, sort])

  const total = useMemo(() => statOf('*', rows), [rows])
  const client = clients.find(c => c.entity === picked) ?? sorted[0] ?? null
  const pick = (e: string, l?: ListKey) => {
    setPicked(e); if (l) setList(l)
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  const sortBy = (key: SortKey) => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'entity' && key !== 'respPct' }))

  // entrada × saída por dia
  const daily = useMemo(() => {
    if (!rep) return []
    const pts: { day: string; opened: number; solved: number; cancelled: number }[] = []
    for (let d = rep.from; d <= rep.to; d = addDays(d, 1)) pts.push({ day: d, opened: 0, solved: 0, cancelled: 0 })
    const idx = new Map(pts.map((p, i) => [p.day, i]))
    for (const r of rows) {
      if (r.t.inOpened) { const i = idx.get(dayOf(r.t.openedAtUtc) ?? ''); if (i !== undefined) pts[i]!.opened++ }
      if (r.t.inSolved) { const i = idx.get(dayOf(r.t.solvedAtUtc) ?? ''); if (i !== undefined) { if (r.cancelled) pts[i]!.cancelled++; else pts[i]!.solved++ } }
    }
    return pts
  }, [rep, rows])

  const exportCsv = () => {
    const esc = (s: string | number | null | undefined) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const lines = [['Cliente', 'Índice de risco', 'Nível', 'Em atraso', 'Fila atual', `Abertos (${days}d)`, `Resolvidos (${days}d)`, `Cancelados (${days}d)`, 'Saldo', 'Resposta mediana (h úteis)', 'Resposta no prazo (%)', 'Parados', 'Sem responsável', 'Reabertos', 'Duplicados', 'Problemas recorrentes'].map(esc).join(';')]
    for (const c of sorted) {
      lines.push([shortEntity(c.entity), c.score, c.level === 'crit' ? 'Crítico' : c.level === 'warn' ? 'Atenção' : 'Estável', c.overdue.length, c.backlog.length, c.opened.length, c.resolved.length, c.cancelled.length, c.net,
        c.respMedian?.toFixed(1).replace('.', ','), c.respWithSla ? pct(c.respWithin, c.respWithSla) : '', c.stale.length, c.unassigned.length, c.reopened.length, c.dups.length,
        c.recurring.map(([p, rs]) => `${p} (${rs.length})`).join(' | ')].map(esc).join(';'))
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `por-cliente-${rep?.from ?? ''}_${rep?.to ?? ''}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const period = rep ? `${fmtDay(rep.from)} a ${fmtDay(rep.to)}` : `últimos ${days} dias`
  const overSla = total.overdue.filter(r => r.overdue === 'sla').length
  const pausedLate = total.backlog.filter(r => r.t.status === 4 && r.t.ttrDueUtc && (ms(r.t.ttrDueUtc) ?? 0) < new Date(rep?.generatedAtUtc ?? 0).getTime()).length
  const respPct = pct(total.respWithin, total.respWithSla)
  const th = (key: SortKey, label: ReactNode, cls = 'num', title?: string) => (
    <th className={cls} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined} title={title}>
      <button type="button" className="cl-sort" onClick={() => sortBy(key)}>{label}{sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}</button>
    </th>
  )

  return (
    <TipCtx.Provider value={setTip}>
      <section className="panel pf tr cl">
        <header className="panel-head row">
          <div>
            <h2>Análise por cliente</h2>
            <p>
              Fila atual + tickets <b>abertos</b> e <b>solucionados</b> em <b>{period}</b>
              {rep && <> · gerado em {formatDate(rep.generatedAtUtc)} ({(rep.durationMs / 1000).toFixed(1)}s)</>}
            </p>
          </div>
          <div className="actions">
            <button type="button" onClick={exportCsv} disabled={!clients.length}>Exportar CSV</button>
            <button type="button" className="primary" onClick={() => load(true)} disabled={loading}>{loading ? 'Carregando…' : '⟳ Atualizar'}</button>
          </div>
        </header>

        <div className="pf-filters">
          <span className="cl-flabel">Período</span>
          <div className="seg" role="group" aria-label="Período">
            {DAYS.map(d => <button key={d} type="button" className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{d} dias</button>)}
          </div>
          <span className="cl-flabel" title="Tickets abertos sem prazo de solução (SLA) contam como atrasados depois desta idade">Sem SLA, atraso após</span>
          <div className="seg" role="group" aria-label="Atraso para tickets sem SLA">
            {AGES.map(d => <button key={d} type="button" className={ageDays === d ? 'on' : ''} aria-pressed={ageDays === d} onClick={() => setAgeDays(d)}>{d}d</button>)}
          </div>
          <span className="cl-flabel" title="Ticket aberto sem nenhuma atualização no ITSM há mais deste tempo">Parado há mais de</span>
          <div className="seg" role="group" aria-label="Parado há mais de">
            {STALES.map(d => <button key={d} type="button" className={staleDays === d ? 'on' : ''} aria-pressed={staleDays === d} onClick={() => setStaleDays(d)}>{d}d</button>)}
          </div>
        </div>

        {error && <div className="banner error">Falha ao gerar o relatório: {error}</div>}
        {data?.error && <div className="banner error">Falha ao consultar o ITSM: {data.error}{rep && ' — exibindo o último relatório gerado.'}</div>}
        {data?.throttledSeconds && <div className="banner info">Atualização limitada a 1 a cada {data.throttledSeconds}s — exibindo o último relatório.</div>}
        {rep?.warnings.map(w => <div key={w} className="banner warn">{w}</div>)}
        {!rep && loading && <p className="empty center">Gerando a análise…</p>}

        {rep && (rows.length === 0 ? <p className="empty center">Nenhum ticket com os filtros atuais.</p> : <>
          <section className="kpis pf-kpis cl-kpis" aria-label="Visão geral">
            <div className="kpi tone-red"><span className="kpi-value">{total.overdue.length}</span><span className="kpi-label">Em atraso agora</span><span className="kpi-sub">{overSla} com SLA vencido · {total.overdue.length - overSla} sem SLA há +{ageDays}d · fila {total.backlog.length}{pausedLate ? ` · ${pausedLate} pendente(s) com prazo pausado` : ''}</span></div>
            <div className="kpi pf-kpi-tto"><span className="kpi-value">{total.opened.length}</span><span className="kpi-label">Abertos em {days} dias</span><span className="kpi-sub">{(total.opened.length / days).toFixed(1).replace('.', ',')} por dia · {clients.filter(c => c.opened.length).length} cliente(s)</span></div>
            <div className="kpi pf-kpi-ttr"><span className="kpi-value">{total.resolved.length}</span><span className="kpi-label">Resolvidos em {days} dias</span><span className="kpi-sub">+ {total.cancelled.length} cancelado(s) · saldo {total.net > 0 ? `+${total.net}` : total.net} {total.net > 0 ? '(fila crescendo)' : total.net < 0 ? '(fila diminuindo)' : ''}</span></div>
            <div className="kpi tone-blue"><span className="kpi-value">{formatDuration(total.respMedian)}</span><span className="kpi-label">Tempo de resposta (mediana)</span><span className="kpi-sub">{total.respWithSla ? `${respPct}% no prazo do SLA` : 'sem SLA de atendimento'} · {total.waiting} aguardando técnico</span></div>
            <div className="kpi tone-amber"><span className="kpi-value">{total.stale.length}</span><span className="kpi-label">Parados há +{staleDays}d</span><span className="kpi-sub">{total.unassigned.length} sem responsável · {total.backlog.filter(r => r.t.status === 4).length} pendente(s)</span></div>
            <div className="kpi tone-gray"><span className="kpi-value">{total.reopened.length}</span><span className="kpi-label">Reabertos no período</span><span className="kpi-sub">{total.cancelled.filter(r => r.t.cancel === 'duplicidade').length} cancelado(s) por duplicidade · {total.dups.filter(d => d.kind === 'possivel').length} possível(is) duplicado(s)</span></div>
          </section>

          {/* ---------- 1. visão geral ---------- */}
          <h3 className="pf-sec"><span>1</span>Visão geral — todos os clientes</h3>
          <Card title="Entrada × saída por dia" hint="Tickets abertos e resolvidos (sem cancelados) em cada dia. Saída menor que a entrada por vários dias = fila crescendo.">
            <PairCols points={daily} />
          </Card>

          <Card title="Clientes que pedem atenção" hint="Ordenado pelo índice de risco. Clique no cabeçalho para ordenar e na linha para abrir o detalhe do cliente.">
            <div className="table-wrap">
              <table className="grid pf-table cl-sum">
                <thead><tr>
                  {th('entity', 'Cliente', 'left')}{th('score', 'Risco', 'left', 'Índice de risco: soma ponderada dos sinais (veja a nota abaixo da tabela)')}
                  {th('overdue', 'Em atraso')}{th('backlog', 'Fila')}{th('opened', 'Abertos')}{th('resolved', 'Resolvidos')}{th('net', 'Saldo', 'num', 'Abertos − (resolvidos + cancelados) no período')}
                  {th('resp', 'Resposta', 'num', 'Mediana do tempo até o técnico assumir (horário útil do SLA)')}{th('respPct', '% no prazo', 'num', 'Tickets assumidos dentro do prazo de atendimento do SLA')}
                  {th('stale', 'Parados')}{th('unassigned', 'Sem resp.')}{th('reopened', 'Reabertos')}{th('dups', 'Duplic.')}{th('cancelled', 'Cancel.')}
                  <th className="left">Problema recorrente</th>
                </tr></thead>
                <tbody>
                  {sorted.slice(0, limit).map(c => (
                    <tr key={c.entity} className={client?.entity === c.entity ? 'on' : ''} onClick={() => pick(c.entity)}>
                      <td className="left"><button type="button" className="link" onClick={e => { e.stopPropagation(); pick(c.entity) }} title={c.entity}>{shortEntity(c.entity)}</button></td>
                      <td className="left"><Risk c={c} /></td>
                      <Num v={c.overdue.length} bad onClick={() => pick(c.entity, 'overdue')} />
                      <td className="num">{c.backlog.length || '·'}</td>
                      <Num v={c.opened.length} onClick={() => pick(c.entity, 'opened')} />
                      <Num v={c.resolved.length} onClick={() => pick(c.entity, 'resolved')} />
                      <td className={`num${c.net > 0 ? ' cl-up' : ''}`}>{c.net > 0 ? `+${c.net}` : c.net || '·'}</td>
                      <td className="num">{c.respN ? formatDuration(c.respMedian) : '·'}</td>
                      <td className={`num${c.respWithSla && pct(c.respWithin, c.respWithSla) < 80 ? ' cl-bad' : ''}`}>{c.respWithSla ? `${pct(c.respWithin, c.respWithSla)}%` : '·'}</td>
                      <Num v={c.stale.length} bad onClick={() => pick(c.entity, 'stale')} />
                      <Num v={c.unassigned.length} bad onClick={() => pick(c.entity, 'unassigned')} />
                      <Num v={c.reopened.length} bad onClick={() => pick(c.entity, 'reopened')} />
                      <Num v={c.dups.length} onClick={() => pick(c.entity, 'dups')} />
                      <Num v={c.cancelled.length} onClick={() => pick(c.entity, 'cancelled')} />
                      <td className="left tr-wrap">{c.recurring[0] ? <button type="button" className="pf-chip cl-chip" onClick={e => { e.stopPropagation(); pick(c.entity, 'recurring') }} title={c.recurring[0][0]}>{lastPart(c.recurring[0][0])} <b>×{c.recurring[0][1].length}</b></button> : <span className="muted">—</span>}{c.recurring.length > 1 && <span className="muted"> +{c.recurring.length - 1}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sorted.length > limit && <button type="button" className="pf-more" onClick={() => setLimit(l => l + 30)}>Mostrar mais clientes ({sorted.length - limit} restantes)</button>}
            <p className="pf-note cl-note">
              <b>Índice de risco</b> = {W.overdue}× em atraso + {W.stale}× parados + {W.unassigned}× sem responsável + {W.reopened}× reabertos + {W.respLate}× resposta fora do prazo + saldo positivo da fila + {W.recurring}× problema recorrente ({RECUR_MIN}+ tickets) + {W.dup}× duplicado.
              {' '}<span className="pill crit">Crítico</span> a partir de {LEVEL.crit} · <span className="pill warn">Atenção</span> a partir de {LEVEL.warn}. Passe o mouse sobre o índice para ver a composição.
            </p>
          </Card>

          <div className="pf-grid pf-grid-2">
            <Card title="Tickets em atraso por cliente" hint={`Fila atual: SLA de solução vencido ou, sem SLA, aberto há mais de ${ageDays} dias. Clique para ver a lista.`}>
              <HBars tone="ttr" fmt={v => String(v)} picked={null} onPick={id => pick(String(id), 'overdue')}
                rows={[...clients].filter(c => c.overdue.length).sort((a, b) => b.overdue.length - a.overdue.length).slice(0, 20).map(c => {
                  const sla = c.overdue.filter(r => r.overdue === 'sla').length
                  const worst = c.overdue.reduce((m, r) => Math.max(m, r.lateH), 0)
                  return {
                    id: c.entity, label: shortEntity(c.entity), value: c.overdue.length, sub: `fila ${c.backlog.length}`,
                    tip: <><b>{shortEntity(c.entity)}</b><br />{c.overdue.length} em atraso ({sla} SLA vencido · {c.overdue.length - sla} sem SLA)<br />Maior atraso: {formatDuration(worst)}<br />Fila atual: {c.backlog.length}</>,
                  }
                })} />
            </Card>
            <Card title="Tempo de resposta por cliente" hint={`Mediana até o técnico assumir, tickets abertos em ${days} dias (horário útil do SLA). Clique para ver os tickets.`}>
              <HBars tone="tto" fmt={v => formatDuration(v)} picked={null} onPick={id => pick(String(id), 'opened')}
                rows={[...clients].filter(c => c.respN).sort((a, b) => (b.respMedian ?? 0) - (a.respMedian ?? 0)).slice(0, 20).map(c => ({
                  id: c.entity, label: shortEntity(c.entity), value: c.respMedian ?? 0, sub: c.respWithSla ? `${pct(c.respWithin, c.respWithSla)}% no prazo` : `${c.respN} ticket(s)`,
                  tip: <><b>{shortEntity(c.entity)}</b><br />Mediana: {formatDuration(c.respMedian)} ({c.respN} assumido(s))<br />{c.respWithSla ? `${c.respWithin} de ${c.respWithSla} no prazo do SLA` : 'Sem SLA de atendimento'}{c.waiting ? <><br />{c.waiting} ainda aguardando técnico</> : null}</>,
                }))} />
            </Card>
          </div>

          {/* ---------- 2. detalhe ---------- */}
          <div ref={detailRef} className="tr-anchor" />
          <h3 className="pf-sec"><span>2</span>Detalhe do cliente
            <select className="tr-pick" value={client?.entity ?? ''} onChange={e => setPicked(e.target.value)} aria-label="Cliente">
              {[...clients].sort((a, b) => shortEntity(a.entity).localeCompare(shortEntity(b.entity), 'pt-BR')).map(c => <option key={c.entity} value={c.entity}>{shortEntity(c.entity)} ({c.rows.length})</option>)}
            </select>
          </h3>
          {client && <ClientDetail c={client} list={list} setList={setList} who={who} days={days} ageDays={ageDays} staleDays={staleDays} />}
        </>)}
      </section>
      <TipBox tip={tip} />
    </TipCtx.Provider>
  )
}

/* ---------- cálculo por cliente ---------- */
function statOf(entity: string, rs: Row[]): ClientStat {
  const backlog = rs.filter(r => r.t.inBacklog)
  const overdue = backlog.filter(r => r.overdue).sort((a, b) => b.lateH - a.lateH)
  const stale = backlog.filter(r => r.stale).sort((a, b) => b.idleH - a.idleH)
  const unassigned = backlog.filter(r => r.unassigned)
  const opened = rs.filter(r => r.t.inOpened)
  const resolved = rs.filter(r => r.resolved)
  const cancelled = rs.filter(r => r.cancelled)
  const reopened = rs.filter(r => r.reopened)
  const resp = opened.map(r => r.resp).filter((x): x is number => x !== null)
  const withSla = opened.filter(r => r.respHasSla)
  const respLate = opened.filter(r => r.respLate).length
  const net = opened.length - resolved.length - cancelled.length

  const probs = new Map<string, Row[]>()
  for (const r of opened) if (r.problem) { const l = probs.get(entity === '*' ? `${r.entity}|${r.problem}` : r.problem); if (l) l.push(r); else probs.set(entity === '*' ? `${r.entity}|${r.problem}` : r.problem, [r]) }
  const recurring = [...probs.entries()].filter(([, l]) => l.length >= RECUR_MIN).sort((a, b) => b[1].length - a[1].length)

  const dups = entity === '*' ? dupsAll(rs) : dupPairs(rs)
  const p: [string, number][] = [
    ['Em atraso', W.overdue * overdue.length], ['Parados', W.stale * stale.length], ['Sem responsável', W.unassigned * unassigned.length],
    ['Reabertos', W.reopened * reopened.length], ['Resposta fora do prazo', W.respLate * respLate], ['Fila crescendo', W.net * Math.max(0, net)],
    ['Problemas recorrentes', W.recurring * recurring.length], ['Duplicados', W.dup * dups.length],
  ]
  const score = p.reduce((s, [, v]) => s + v, 0)
  return {
    entity, rows: rs, backlog, overdue, stale, unassigned, opened, resolved, cancelled, reopened,
    respMedian: median(resp), respN: resp.length, respWithin: withSla.filter(r => !r.respLate).length, respWithSla: withSla.length, respLate,
    waiting: opened.filter(r => r.waiting).length, net, recurring, dups,
    score, level: score >= LEVEL.crit ? 'crit' : score >= LEVEL.warn ? 'warn' : 'ok', parts: p.filter(([, v]) => v > 0),
  }
}

function dupsAll(rs: Row[]) {
  const by = new Map<string, Row[]>()
  for (const r of rs) { const l = by.get(r.entity); if (l) l.push(r); else by.set(r.entity, [r]) }
  return [...by.values()].flatMap(dupPairs)
}

/** Duplicados de um cliente: cancelados por duplicidade (marcado) e pares parecidos não marcados (possível). */
function dupPairs(rs: Row[]): DupPair[] {
  const byId = new Map(rs.map(r => [r.t.id, r]))
  const out: DupPair[] = []
  const linked = new Set<string>()
  for (const r of rs) {
    if (!(r.cancelled && r.t.cancel === 'duplicidade')) continue
    const o = r.t.duplicateOf !== null ? byId.get(r.t.duplicateOf) : undefined
    out.push({ a: o ?? r, b: r, kind: 'marcado', score: 1 })
    if (o) linked.add(`${Math.min(o.t.id, r.t.id)}-${Math.max(o.t.id, r.t.id)}`)
  }
  const cand = rs.filter(r => r.t.inOpened && !(r.t.cancel === 'duplicidade')).sort((a, b) => (ms(a.t.openedAtUtc) ?? 0) - (ms(b.t.openedAtUtc) ?? 0))
  const tk = new Map(cand.map(r => [r.t.id, tokens(r.t.title)]))
  const used = new Set<number>()
  for (let i = 0; i < cand.length; i++) {
    const a = cand[i]!
    if (used.has(a.t.id)) continue
    for (let j = i + 1; j < cand.length; j++) {
      const b = cand[j]!
      if ((ms(b.t.openedAtUtc) ?? 0) - (ms(a.t.openedAtUtc) ?? 0) > DUP_WINDOW_H * H) break
      if (used.has(b.t.id) || linked.has(`${a.t.id}-${b.t.id}`)) continue
      if (!a.t.requesterIds.some(id => b.t.requesterIds.includes(id))) continue
      const s = similar(tk.get(a.t.id)!, tk.get(b.t.id)!)
      if (s >= 0.6) { out.push({ a, b, kind: 'possivel', score: s }); used.add(b.t.id); break }
    }
  }
  return out
}

const lastPart = (p: string) => { const x = p.split('›').map(s => s.trim()); return x.slice(1).join(' › ') || x[0]! }

/* ---------- peças ---------- */
function Num({ v, bad, onClick }: { v: number; bad?: boolean; onClick: () => void }) {
  if (!v) return <td className="num muted">·</td>
  return <td className={`num${bad ? ' cl-bad' : ''}`}><button type="button" className="link" onClick={e => { e.stopPropagation(); onClick() }}>{v}</button></td>
}

function Risk({ c }: { c: ClientStat }) {
  const setTip = useContext(TipCtx)
  const label = c.level === 'crit' ? 'Crítico' : c.level === 'warn' ? 'Atenção' : 'Estável'
  return (
    <span className={`cl-risk ${c.level}`} {...tipProps(setTip, () => (
      <><b>{shortEntity(c.entity)} · índice {c.score}</b>{c.parts.length ? c.parts.map(([k, v]) => <Fragment key={k}><br />{k}: +{v}</Fragment>) : <><br />Nenhum sinal de problema no período</>}</>
    ))}>
      <span className="cl-risk-n">{c.score}</span>{label}
    </span>
  )
}

/** Colunas pareadas: abertos × resolvidos por dia (cancelados ficam só na dica). */
function PairCols({ points }: { points: { day: string; opened: number; solved: number; cancelled: number }[] }) {
  const setTip = useContext(TipCtx)
  const max = Math.max(1, ...points.map(p => Math.max(p.opened, p.solved)))
  const nice = max <= 4 ? max : Math.ceil(max / 4) * 4
  const every = Math.max(1, Math.ceil(points.length / 15))
  const tin = points.reduce((s, p) => s + p.opened, 0), tout = points.reduce((s, p) => s + p.solved, 0)
  const wd = (d: string) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(d + 'T12:00').getDay()]
  return (
    <>
      <div className="cl-legend" aria-hidden><span><i className="cl-bar in" />Abertos ({tin})</span><span><i className="cl-bar out" />Resolvidos ({tout})</span></div>
      <div className="pf-cols">
        <div className="pf-cols-y" aria-hidden>{[nice, nice / 2, 0].map(v => <span key={v}>{Number.isInteger(v) ? v : v.toFixed(1)}</span>)}</div>
        <div className="pf-cols-body">
          <div className="pf-cols-plot" role="img" aria-label={`${tin} abertos e ${tout} resolvidos no período`}>
            <i className="pf-grid-line" style={{ bottom: '50%' }} /><i className="pf-grid-line" style={{ bottom: '100%' }} />
            {points.map(p => (
              <div key={p.day} className="cl-day" {...tipProps(setTip, () => <><b>{wd(p.day)} {fmtDay(p.day)}</b><br />Abertos: {p.opened}<br />Resolvidos: {p.solved}{p.cancelled ? <><br />Cancelados: {p.cancelled}</> : null}<br />Saldo do dia: {p.opened - p.solved - p.cancelled > 0 ? '+' : ''}{p.opened - p.solved - p.cancelled}</>)}>
                <span className="cl-bar in" style={{ height: `${(p.opened / nice) * 100}%` }} />
                <span className="cl-bar out" style={{ height: `${(p.solved / nice) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="pf-cols-x" aria-hidden>{points.map((p, i) => <span key={p.day}>{i % every === 0 ? p.day.slice(8) + '/' + p.day.slice(5, 7) : ''}</span>)}</div>
        </div>
      </div>
    </>
  )
}

/* ---------- detalhe ---------- */
function ClientDetail({ c, list, setList, who, days, ageDays, staleDays }: { c: ClientStat; list: ListKey; setList: (l: ListKey) => void; who: (ids: number[]) => string; days: number; ageDays: number; staleDays: number }) {
  const tabs: { key: ListKey; label: string; n: number }[] = [
    { key: 'overdue', label: 'Em atraso', n: c.overdue.length }, { key: 'stale', label: `Parados +${staleDays}d`, n: c.stale.length },
    { key: 'unassigned', label: 'Sem responsável', n: c.unassigned.length }, { key: 'opened', label: `Abertos ${days}d`, n: c.opened.length },
    { key: 'resolved', label: `Resolvidos ${days}d`, n: c.resolved.length }, { key: 'cancelled', label: 'Cancelados', n: c.cancelled.length },
    { key: 'reopened', label: 'Reabertos', n: c.reopened.length }, { key: 'dups', label: 'Duplicados', n: c.dups.length },
    { key: 'recurring', label: 'Recorrentes', n: c.recurring.length },
  ]
  const reqTop = useMemo(() => {
    const m = new Map<number, number>()
    for (const r of c.opened) for (const id of r.t.requesterIds) m.set(id, (m.get(id) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]
  }, [c])
  const sla = c.overdue.filter(r => r.overdue === 'sla').length

  return (
    <div className="tr-detail">
      <section className="kpis pf-kpis tr-mini" aria-label={`Resumo de ${shortEntity(c.entity)}`}>
        <div className="kpi tone-gray"><span className="kpi-value"><span className={`cl-risk ${c.level}`}><span className="cl-risk-n">{c.score}</span>{c.level === 'crit' ? 'Crítico' : c.level === 'warn' ? 'Atenção' : 'Estável'}</span></span><span className="kpi-label">Índice de risco</span><span className="kpi-sub">{c.parts.length ? c.parts.slice().sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} +${v}`).join(' · ') : 'sem sinais de problema'}</span></div>
        <div className="kpi tone-red"><span className="kpi-value">{c.overdue.length}</span><span className="kpi-label">Em atraso de {c.backlog.length} na fila</span><span className="kpi-sub">{sla} SLA vencido · {c.overdue.length - sla} sem SLA há +{ageDays}d</span></div>
        <div className="kpi pf-kpi-tto"><span className="kpi-value">{c.opened.length} → {c.resolved.length}</span><span className="kpi-label">Abertos → resolvidos ({days}d)</span><span className="kpi-sub">{c.cancelled.length} cancelado(s) · saldo {c.net > 0 ? `+${c.net}` : c.net}{reqTop ? <> · quem mais abre: <b>{who([reqTop[0]])}</b> ({reqTop[1]})</> : null}</span></div>
        <div className="kpi tone-blue"><span className="kpi-value">{c.respN ? formatDuration(c.respMedian) : '—'}</span><span className="kpi-label">Tempo de resposta (mediana)</span><span className="kpi-sub">{c.respWithSla ? `${pct(c.respWithin, c.respWithSla)}% no prazo (${c.respWithin}/${c.respWithSla})` : 'sem SLA de atendimento'}{c.waiting ? ` · ${c.waiting} aguardando` : ''}</span></div>
      </section>

      <div className="seg cl-tabs" role="tablist" aria-label="Listas do cliente">
        {tabs.map(t => <button key={t.key} type="button" role="tab" aria-selected={list === t.key} className={list === t.key ? 'on' : ''} onClick={() => setList(t.key)}>{t.label} <b>{t.n}</b></button>)}
      </div>

      <Card title={tabs.find(t => t.key === list)!.label} hint={HINTS[list](days, ageDays, staleDays)}>
        {list === 'dups' ? <DupList pairs={c.dups} who={who} />
          : list === 'recurring' ? <RecurList groups={c.recurring} who={who} />
            : <TicketTable key={`${c.entity}|${list}`} rows={{ overdue: c.overdue, stale: c.stale, unassigned: c.unassigned, opened: c.opened, resolved: c.resolved, cancelled: c.cancelled, reopened: c.reopened }[list]} kind={list} who={who} />}
      </Card>
    </div>
  )
}

const HINTS: Record<ListKey, (d: number, a: number, s: number) => string> = {
  overdue: (_d, a) => `Tickets na fila com o prazo de solução do SLA vencido ou, sem SLA, abertos há mais de ${a} dias — do maior atraso para o menor. Pendentes ficam de fora (o ITSM pausa o prazo); veja-os em "Parados".`,
  stale: (_d, _a, s) => `Tickets na fila sem nenhuma atualização no ITSM há mais de ${s} dias (inclui pendentes: confira se aguardam o cliente).`,
  unassigned: () => 'Tickets na fila (novos ou em atendimento) sem técnico atribuído.',
  opened: d => `Abertos nos últimos ${d} dias. Resposta = tempo até o técnico assumir, em horário útil do SLA.`,
  resolved: d => `Solucionados ou fechados nos últimos ${d} dias, sem os cancelados.`,
  cancelled: () => 'Cancelados no período, pelo tipo de solução. Duplicidade é identificada pelo texto da solução ou pelo vínculo "Duplica" do ITSM.',
  reopened: () => 'Tickets com solução recusada (reabertos) no período.',
  dups: () => `Marcados: cancelados por duplicidade. Possíveis: mesmo requerente, títulos parecidos e abertos com até ${DUP_WINDOW_H} h de diferença, ainda não tratados como duplicados.`,
  recurring: () => `Mesmo problema (categoria a partir do 2º nível) em ${RECUR_MIN} ou mais tickets abertos no período.`,
}

function Tk({ r }: { r: Row }) {
  return <a href={r.t.url} target="_blank" rel="noreferrer">#{r.t.id}</a>
}

function TicketTable({ rows, kind, who }: { rows: Row[]; kind: Exclude<ListKey, 'dups' | 'recurring'>; who: (ids: number[]) => string }) {
  const [limit, setLimit] = useState(50)
  if (!rows.length) return <p className="empty">Nenhum ticket nesta lista. 👍</p>
  const extra: Record<typeof kind, [string, string, (r: Row) => ReactNode, (r: Row) => ReactNode]> = {
    overdue: ['Prazo', 'Atraso', r => (r.overdue === 'sla' ? formatDate(r.t.ttrDueUtc) : <span className="muted">sem SLA</span>), r => <b className="cl-bad">{r.overdue === 'sla' ? formatDuration(r.lateH) : `${formatDuration(r.lateH)} aberto`}</b>],
    stale: ['Última atualização', 'Parado há', r => formatDate(r.t.updatedAtUtc), r => <b>{formatDuration(r.idleH)}</b>],
    unassigned: ['Prazo de atendimento', 'Aguardando há', r => formatDate(r.t.ttoDueUtc), r => formatDuration((Date.now() - (ms(r.t.openedAtUtc) ?? Date.now())) / H)],
    opened: ['Resposta', 'No prazo?', r => (r.resp !== null ? formatDuration(r.resp) : r.waiting ? <span className="cl-bad">aguardando</span> : <span className="muted">—</span>), r => (!r.respHasSla ? <span className="muted">sem SLA</span> : r.respLate ? <span className="cl-bad">não</span> : 'sim')],
    resolved: ['Solução', 'Tempo de solução', r => formatDate(r.t.solvedAtUtc), r => formatDuration(hrs(r.t.solveDelaySec))],
    cancelled: ['Cancelado em', 'Motivo', r => formatDate(r.t.solvedAtUtc), r => <>{r.t.cancel ? CANCEL_LABEL[r.t.cancel] : '—'}{r.t.duplicateOf ? <> · original <a href={r.t.url.replace(/id=\d+$/, `id=${r.t.duplicateOf}`)} target="_blank" rel="noreferrer">#{r.t.duplicateOf}</a></> : null}</>],
    reopened: ['Reaberturas', 'Situação', r => `${r.t.reopenedInPeriod} no período${r.t.reopenedTotal > r.t.reopenedInPeriod ? ` (${r.t.reopenedTotal} no total)` : ''}`, r => (r.t.inBacklog ? <span className="cl-bad">aberto de novo</span> : 'solucionado')],
  }
  const [h1, h2, c1, c2] = extra[kind]
  return (
    <>
      <div className="table-wrap">
        <table className="grid pf-table cl-tks">
          <thead><tr><th className="left">Ticket</th><th className="left">Título</th><th className="left">Status</th><th className="left">Técnico</th><th className="left">Requerente</th><th className="left">Abertura</th><th className="left">{h1}</th><th className="left">{h2}</th></tr></thead>
          <tbody>
            {rows.slice(0, limit).map(r => (
              <tr key={r.t.id}>
                <td className="left"><Tk r={r} /></td>
                <td className="left tr-wrap cl-title" title={r.t.category ?? ''}>{r.t.title}</td>
                <td className="left">{r.t.statusLabel}</td>
                <td className="left">{r.t.techIds.length ? who(r.t.techIds) : <span className="cl-bad">sem técnico</span>}</td>
                <td className="left">{who(r.t.requesterIds)}</td>
                <td className="left">{formatDate(r.t.openedAtUtc)}</td>
                <td className="left">{c1(r)}</td>
                <td className="left">{c2(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button type="button" className="pf-more" onClick={() => setLimit(l => l + 100)}>Mostrar mais ({rows.length - limit} restantes)</button>}
    </>
  )
}

function DupList({ pairs, who }: { pairs: DupPair[]; who: (ids: number[]) => string }) {
  if (!pairs.length) return <p className="empty">Nenhum duplicado no período. 👍</p>
  return (
    <ul className="cl-dups">
      {pairs.map(p => (
        <li key={`${p.a.t.id}-${p.b.t.id}`}>
          <span className={`pill ${p.kind === 'marcado' ? 'flag' : 'warn'}`}>{p.kind === 'marcado' ? 'Cancelado por duplicidade' : `Possível · ${Math.round(p.score * 100)}% parecido`}</span>
          {p.a !== p.b ? <span className="cl-pair"><span className="cl-role">{p.kind === 'marcado' ? 'Original' : 'Primeiro'}</span><Tk r={p.a} /> {p.a.t.title} <span className="muted">({formatDate(p.a.t.openedAtUtc)})</span></span> : p.b.t.duplicateOf ? <span className="cl-pair muted">original #{p.b.t.duplicateOf} (fora do período ou de outro filtro)</span> : <span className="cl-pair muted">original não informado na solução</span>}
          <span className="cl-pair"><span className="cl-role">{p.kind === 'marcado' ? 'Cancelado' : 'Repetido'}</span><Tk r={p.b} /> {p.b.t.title} <span className="muted">({formatDate(p.b.t.openedAtUtc)} · {who(p.b.t.requesterIds)} · {p.b.t.statusLabel})</span></span>
        </li>
      ))}
    </ul>
  )
}

function RecurList({ groups, who }: { groups: [string, Row[]][]; who: (ids: number[]) => string }) {
  if (!groups.length) return <p className="empty">Nenhum problema com {RECUR_MIN}+ tickets no período.</p>
  return (
    <ul className="tr-plist">
      {groups.map(([p, rs]) => (
        <li key={p}>
          <span className="tr-pname"><b>{lastPart(p)}</b> <small>{p.split('›')[0]}</small></span>
          <span className="tr-pn">{rs.length}</span>
          <span className="tr-tks">{rs.map(r => <a key={r.t.id} href={r.t.url} target="_blank" rel="noreferrer" title={`${r.t.title} · ${formatDate(r.t.openedAtUtc)} · ${who(r.t.requesterIds)} · ${r.t.statusLabel}`}>#{r.t.id}</a>)}</span>
        </li>
      ))}
    </ul>
  )
}

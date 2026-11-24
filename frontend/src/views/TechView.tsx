import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TechReportResponse, TechReportTicket, ThemeSource } from '../types'
import { apiUrl, formatDate } from '../format'
import { NO_ENTITY, shortEntity } from '../entity'
import { Card, HBars, TipBox } from './vizKit'
import { addDays, daysBetween, fmtDay, TipCtx, tipProps, ymd, type Tip } from './vizCore'

/* ---------- período ---------- */
const MAX_DAYS = 366
type Preset = '30d' | '90d' | 'mes' | 'mesant' | '6m' | '12m' | 'custom'
const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'mes', label: 'Este mês' }, { id: 'mesant', label: 'Mês anterior' }, { id: '30d', label: '30 dias' },
  { id: '90d', label: '90 dias' }, { id: '6m', label: '6 meses' }, { id: '12m', label: '12 meses' },
]
function presetRange(p: Exclude<Preset, 'custom'>): [string, string] {
  const t = ymd(new Date())
  switch (p) {
    case '30d': return [addDays(t, -29), t]
    case '90d': return [addDays(t, -89), t]
    case '6m': return [addDays(t, -182), t]
    case '12m': return [addDays(t, -364), t]
    case 'mes': return [t.slice(0, 8) + '01', t]
    case 'mesant': { const n = new Date(); return [ymd(new Date(n.getFullYear(), n.getMonth() - 1, 1)), ymd(new Date(n.getFullYear(), n.getMonth(), 0))] }
  }
}

/* ---------- temas e problemas ---------- */
const NO_TECH = -1
const NO_THEME = '∅'
const N1 = '|n1'   // sufixo: ticket só no nível 1 (sem nível 2 seguro)
const parts = (c: string | null | undefined) => (c ? c.split('>').map(s => s.trim()).filter(Boolean) : [])

/** Tema (chave) do ticket; sem inferência, volta ao que está no ITSM. */
function themeOf(t: TechReportTicket, useInfer: boolean): { key: string; source: ThemeSource } {
  let source = t.themeSource
  let theme = t.theme
  if (source === 'inferido' && !useInfer) {
    const p = parts(t.category)
    if (p.length === 1) { source = 'nivel1'; theme = p[0]! } else { source = 'sem'; theme = null }
  }
  if (source === 'sem' || !theme) return { key: NO_THEME, source: 'sem' }
  return { key: source === 'nivel1' ? theme + N1 : theme, source }
}
/** Rótulo curto (nível 2) + grupo (nível 1). */
function themeParts(key: string): { main: string; group: string } {
  if (key === NO_THEME) return { main: 'Sem categoria', group: 'Sem categoria' }
  if (key.endsWith(N1)) return { main: 'Sem nível 2', group: key.slice(0, -N1.length) }
  const p = parts(key)
  return p.length >= 2 ? { main: p[1]!, group: p[0]! } : { main: p[0]!, group: p[0]! }
}
const themeFull = (key: string) => { const { main, group } = themeParts(key); return main === group ? main : `${group} › ${main}` }

/** Problema = categoria mais específica (nível 3); sem nível 3, o próprio tema. */
function problemOf(t: TechReportTicket, themeKey: string): string {
  return parts(t.category).length >= 3 ? parts(t.category).join(' > ') : themeKey
}
function problemParts(key: string): { main: string; group: string } {
  if (key === NO_THEME || key.endsWith(N1)) return themeParts(key)
  const p = parts(key)
  if (p.length >= 3) return { main: p.slice(2).join(' › '), group: `${p[0]} › ${p[1]}` }
  return themeParts(key)
}

interface Row { t: TechReportTicket; theme: string; source: ThemeSource; problem: string; entity: string; techs: number[]; reqs: number[] }

interface TechStat {
  id: number; name: string; n: number
  themes: Map<string, Row[]>; entities: Map<string, Row[]>; reqs: Map<number, Row[]>; cats: Map<string, number>
}

function group<K>(rows: Row[], key: (r: Row) => K | K[]): Map<K, Row[]> {
  const m = new Map<K, Row[]>()
  for (const r of rows) {
    const k = key(r)
    for (const x of Array.isArray(k) ? k : [k]) { const l = m.get(x); if (l) l.push(r); else m.set(x, [r]) }
  }
  return m
}
const byCount = <K,>(m: Map<K, Row[]>) => [...m.entries()].sort((a, b) => b[1].length - a[1].length)
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
const shortName = (s: string) => { const p = s.split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1]![0]}.` : s }
const bin = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n <= 4 ? 2 : n <= 14 ? 3 : n <= 49 ? 4 : 5)
const BINS = ['1', '2–4', '5–14', '15–49', '50+']

interface Props { filter: string; entitySel: Set<string> | null; techSel: Set<number> | null }

export default function TechView({ filter, entitySel, techSel }: Props) {
  const [preset, setPreset] = useState<Preset>(() => { try { const v = localStorage.getItem('tech.preset'); return PRESETS.some(p => p.id === v) ? v as Preset : '12m' } catch { return '12m' } })
  const [range, setRange] = useState<[string, string]>(() => presetRange(preset === 'custom' ? '12m' : preset))
  const [useInfer, setUseInfer] = useState(() => { try { return localStorage.getItem('tech.infer') !== '0' } catch { return true } })
  const [data, setData] = useState<TechReportResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip>(null)
  const [pickedTech, setPickedTech] = useState<number | null>(null)
  const [openEntity, setOpenEntity] = useState<string | null>(null)
  const [reqLimit, setReqLimit] = useState(15)
  const detailRef = useRef<HTMLDivElement>(null)
  const [from, to] = range

  useEffect(() => { try { if (preset !== 'custom') localStorage.setItem('tech.preset', preset) } catch { /* sem storage */ } }, [preset])
  useEffect(() => { try { localStorage.setItem('tech.infer', useInfer ? '1' : '0') } catch { /* sem storage */ } }, [useInfer])

  const choose = (p: Exclude<Preset, 'custom'>) => { setPreset(p); setRange(presetRange(p)); setOpenEntity(null) }
  const setDay = (which: 0 | 1, v: string) => {
    if (!v) return
    setPreset('custom'); setOpenEntity(null)
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
      const res = await fetch(apiUrl(`/api/reports/technicians?from=${from}&to=${to}${refresh ? '&refresh=true' : ''}`), { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
      setData(body as TechReportResponse)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { void load(false) }, [load])

  const rep = data?.report ?? null
  const names = useMemo(() => new Map((rep?.people ?? []).map(p => [p.id, p.name])), [rep])
  const name = useCallback((id: number) => (id === NO_TECH ? 'Sem técnico' : names.get(id) ?? `Usuário #${id}`), [names])

  // tickets do período com os filtros do topo
  const rows = useMemo(() => {
    if (!rep) return []
    const q = filter.trim().toLowerCase()
    const out: Row[] = []
    for (const t of rep.tickets) {
      const techs = t.techIds.length ? t.techIds : [NO_TECH]
      const entity = t.entity ?? NO_ENTITY
      if (entitySel !== null && !entitySel.has(entity)) continue
      if (techSel !== null && !techs.some(id => techSel.has(id))) continue
      if (q && !`#${t.id} ${t.title} ${t.entity ?? ''} ${t.category ?? ''} ${techs.map(name).join(' ')} ${t.requesterIds.map(name).join(' ')}`.toLowerCase().includes(q)) continue
      const th = themeOf(t, useInfer)
      out.push({ t, theme: th.key, source: th.source, problem: problemOf(t, th.key), entity, techs, reqs: t.requesterIds })
    }
    return out
  }, [rep, filter, entitySel, techSel, name, useInfer])

  const techs = useMemo<TechStat[]>(() => byCount(group(rows, r => r.techs)).filter(([id]) => id !== NO_TECH).map(([id, rs]) => ({
    id, name: name(id), n: rs.length,
    themes: group(rs, r => r.theme), entities: group(rs, r => r.entity), reqs: group(rs, r => r.reqs),
    cats: rs.reduce((m, r) => m.set(r.t.category ?? NO_THEME, (m.get(r.t.category ?? NO_THEME) ?? 0) + 1), new Map<string, number>()),
  })), [rows, name])
  const noTech = rows.filter(r => r.techs[0] === NO_TECH).length

  const reqs = useMemo(() => byCount(group(rows, r => r.reqs)), [rows])
  const noReq = rows.filter(r => !r.reqs.length).length
  const sources = useMemo(() => rows.reduce((m, r) => ({ ...m, [r.source]: (m[r.source] ?? 0) + 1 }), {} as Partial<Record<ThemeSource, number>>), [rows])

  // matriz técnico × tema, agrupada pelo nível 1
  const matrix = useMemo(() => {
    const themes = group(rows, r => r.theme)
    const groups = new Map<string, { name: string; n: number; themes: [string, Row[]][] }>()
    for (const [k, rs] of themes) {
      const g = themeParts(k).group
      const e = groups.get(g) ?? { name: g, n: 0, themes: [] }
      e.n += rs.length; e.themes.push([k, rs]); groups.set(g, e)
    }
    const list = [...groups.values()].sort((a, b) => (a.name === 'Sem categoria' ? 1 : b.name === 'Sem categoria' ? -1 : b.n - a.n))
    for (const g of list) g.themes.sort((a, b) => (a[0].endsWith(N1) ? 1 : b[0].endsWith(N1) ? -1 : b[1].length - a[1].length))
    return list
  }, [rows])

  const tech = techs.find(t => t.id === pickedTech) ?? techs[0] ?? null
  const pick = (id: number) => { setPickedTech(id); setOpenEntity(null); requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }

  const exportCsv = () => {
    const esc = (s: string | number | null | undefined) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const src: Record<ThemeSource, string> = { categoria: 'categoria', inferido: 'inferido pelo título', nivel1: 'só nível 1', sem: 'sem categoria' }
    const lines = [['Ticket', 'Título', 'Status', 'Abertura', 'Entidade', 'Técnicos', 'Requerentes', 'Categoria no ITSM', 'Tema (nível 2)', 'Origem do tema', 'Confiança (%)'].map(esc).join(';')]
    for (const r of rows) {
      lines.push([r.t.id, r.t.title, r.t.statusLabel, formatDate(r.t.openedAtUtc), r.t.entity, r.techs.map(name).join(', '), r.reqs.map(name).join(', '),
        r.t.category, r.theme === NO_THEME ? '' : themeFull(r.theme), src[r.source], r.source === 'inferido' ? r.t.confidence : ''].map(esc).join(';'))
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `por-tecnico-${from}_${to}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const period = from === to ? fmtDay(from) : `${fmtDay(from)} a ${fmtDay(to)}`
  const inferred = sources.inferido ?? 0, lvl1 = sources.nivel1 ?? 0, none = sources.sem ?? 0
  const withL2 = rows.length - lvl1 - none
  const topReq = reqs[0]
  const mainEntity = (rs: Row[]) => { const e = byCount(group(rs, r => r.entity))[0]; return e ? shortEntity(e[0]) : '' }
  const top = <K,>(m: Map<K, Row[]>, k: number, label: (key: K) => string) => byCount(m).slice(0, k).map(([key, rs]) => `${label(key)} (${rs.length})`).join(', ')

  return (
    <TipCtx.Provider value={setTip}>
      <section className="panel pf tr">
        <header className="panel-head row">
          <div>
            <h2>Relatório por técnico</h2>
            <p>
              Tickets <b>abertos</b> em <b>{period}</b> · técnico = atribuído no ITSM
              {rep && <> · gerado em {formatDate(rep.generatedAtUtc)} ({(rep.durationMs / 1000).toFixed(1)}s)</>}
            </p>
          </div>
          <div className="actions">
            <button type="button" onClick={exportCsv} disabled={!rows.length}>Exportar CSV</button>
            <button type="button" className="primary" onClick={() => load(true)} disabled={loading}>{loading ? 'Carregando…' : '⟳ Atualizar'}</button>
          </div>
        </header>

        <div className="pf-filters">
          <div className="seg" role="group" aria-label="Período">
            {PRESETS.map(p => <button key={p.id} type="button" className={preset === p.id ? 'on' : ''} aria-pressed={preset === p.id} onClick={() => choose(p.id)}>{p.label}</button>)}
          </div>
          <label className="pf-date">De <input type="date" value={from} max={to} onChange={e => setDay(0, e.target.value)} /></label>
          <label className="pf-date">até <input type="date" value={to} min={from} onChange={e => setDay(1, e.target.value)} /></label>
          <div className="seg" role="group" aria-label="Tema dos tickets sem nível 2">
            <button type="button" className={useInfer ? 'on' : ''} aria-pressed={useInfer} onClick={() => setUseInfer(true)} title="Tickets só no nível 1 (ou sem categoria) recebem o nível 2 deduzido do título, quando há palavra-chave forte">Com inferência</button>
            <button type="button" className={!useInfer ? 'on' : ''} aria-pressed={!useInfer} onClick={() => setUseInfer(false)} title="Usa apenas a categoria registrada no ITSM">Só categoria do ITSM</button>
          </div>
        </div>

        {error && <div className="banner error">Falha ao gerar o relatório: {error}</div>}
        {data?.error && <div className="banner error">Falha ao consultar o ITSM: {data.error}{rep && ' — exibindo o último relatório gerado.'}</div>}
        {data?.throttledSeconds && <div className="banner info">Atualização limitada a 1 a cada {data.throttledSeconds}s — exibindo o último relatório.</div>}
        {rep?.warnings.map(w => <div key={w} className="banner warn">{w}</div>)}
        {!rep && loading && <p className="empty center">Gerando relatório… (12 meses levam cerca de 10 s na primeira vez)</p>}

        {rep && (
          <>
            <section className="kpis pf-kpis" aria-label="Visão geral">
              <div className="kpi tone-gray"><span className="kpi-value">{rows.length}</span><span className="kpi-label">Tickets abertos no período</span><span className="kpi-sub">{techs.length} técnico(s) · {new Set(rows.map(r => r.entity)).size} empresa(s){noTech ? ` · ${noTech} sem técnico` : ''}</span></div>
              <div className="kpi pf-kpi-par"><span className="kpi-value">{matrix.reduce((a, g) => a + g.themes.filter(([k]) => k !== NO_THEME).length, 0)}</span><span className="kpi-label">Temas atendidos (nível 2)</span><span className="kpi-sub">{new Set(rows.map(r => r.t.category).filter(Boolean)).size} categorias distintas no ITSM</span></div>
              <div className="kpi pf-kpi-tto"><span className="kpi-value">{reqs.length}</span><span className="kpi-label">Requerentes</span><span className="kpi-sub">{topReq ? <>quem mais abre: <b>{name(topReq[0])}</b> ({topReq[1].length})</> : '—'}</span></div>
              <div className="kpi pf-kpi-ttr"><span className="kpi-value">{pct(withL2, rows.length)}%</span><span className="kpi-label">Tickets com tema de nível 2</span><span className="kpi-sub">{useInfer ? `${inferred} inferido(s) · ` : ''}{lvl1} só nível 1 · {none} sem categoria</span></div>
            </section>
            <p className="pf-note">
              <b>Tema</b> = 2º nível da categoria do ITSM. {useInfer
                ? <>Tickets classificados só no 1º nível (ou sem categoria) recebem o 2º nível pelo título, <b>só quando há palavra-chave forte</b> aprendida com {rep.trainingTickets.toLocaleString('pt-BR')} tickets já bem classificados nos últimos 12 meses (acerto de 93% a 99% nos testes). Esses aparecem marcados com <i className="tr-inf">◆</i>. Os demais ficam como “Sem nível 2”.</>
                : <>Inferência desligada: vale apenas a categoria registrada no ITSM.</>}
            </p>

            {rows.length === 0 ? <p className="empty center">Nenhum ticket aberto no período com os filtros atuais.</p> : <>

              {/* ---------- 1. visão geral ---------- */}
              <h3 className="pf-sec"><span>1</span>Visão geral — todos os técnicos</h3>
              <Card title="Resumo por técnico" hint="Clique num técnico para ver o detalhe dele na seção 2">
                <div className="table-wrap">
                  <table className="grid pf-table tr-sum">
                    <thead><tr><th className="left">Técnico</th><th className="num">Tickets</th><th className="num">Empresas</th><th className="num">Temas</th><th className="num">Categorias</th><th className="left">Tema mais atendido</th><th className="left">Requerente mais atendido</th></tr></thead>
                    <tbody>
                      {techs.map(s => {
                        const th = byCount(s.themes).find(([k]) => k !== NO_THEME)
                        const rq = byCount(s.reqs)[0]
                        return (
                          <tr key={s.id} className={tech?.id === s.id ? 'on' : ''} onClick={() => pick(s.id)}>
                            <td className="left"><button type="button" className="link" onClick={e => { e.stopPropagation(); pick(s.id) }}>{s.name}</button></td>
                            <td className="num">{s.n}</td><td className="num">{s.entities.size}</td>
                            <td className="num">{[...s.themes.keys()].filter(k => k !== NO_THEME).length}</td>
                            <td className="num">{[...s.cats.keys()].filter(k => k !== NO_THEME).length}</td>
                            <td className="left">{th ? <>{themeFull(th[0])} <span className="muted">({th[1].length})</span></> : '—'}</td>
                            <td className="left">{rq ? <>{name(rq[0])} <span className="muted">({rq[1].length})</span></> : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="Temas que cada técnico já atendeu" hint="Célula preenchida = atendeu pelo menos uma vez no período; o número é a quantidade de tickets. Clique para abrir o técnico.">
                <Matrix groups={matrix} techs={techs} onPick={pick} />
              </Card>

              <Card title="Requerentes que mais abrem chamados" hint={`Todos os tickets do período com os filtros atuais${noReq ? ` · ${noReq} sem requerente` : ''}`}>
                <HBars tone="qty" fmt={v => String(v)} rows={reqs.slice(0, reqLimit).map(([id, rs]) => ({
                  id, label: name(id), sub: mainEntity(rs), value: rs.length,
                  tip: <><b>{name(id)}</b><br />{rs.length} chamado(s) aberto(s)<br />Empresa: {top(group(rs, r => r.entity), 2, shortEntity)}<br />Atendido por: {top(group(rs, r => r.techs), 3, name)}<br />Temas: {top(group(rs, r => r.theme), 3, themeFull)}</>,
                }))} />
                {reqs.length > reqLimit && <button type="button" className="pf-more" onClick={() => setReqLimit(l => l + 35)}>Mostrar mais ({reqs.length - reqLimit} restantes)</button>}
              </Card>

              {/* ---------- 2. detalhe ---------- */}
              <div ref={detailRef} className="tr-anchor" />
              <h3 className="pf-sec"><span>2</span>Detalhe do técnico
                <select className="tr-pick" value={tech?.id ?? ''} onChange={e => { setPickedTech(Number(e.target.value)); setOpenEntity(null) }} aria-label="Técnico">
                  {techs.map(s => <option key={s.id} value={s.id}>{s.name} ({s.n})</option>)}
                </select>
              </h3>
              {tech && <TechDetail s={tech} name={name} openEntity={openEntity} setOpenEntity={setOpenEntity} />}
            </>}
          </>
        )}
      </section>
      <TipBox tip={tip} />
    </TipCtx.Provider>
  )
}

/* ---------- matriz técnico × tema ---------- */
function Matrix({ groups, techs, onPick }: { groups: { name: string; n: number; themes: [string, Row[]][] }[]; techs: TechStat[]; onPick: (id: number) => void }) {
  const setTip = useContext(TipCtx)
  const cover = (s: TechStat) => [...s.themes.keys()].filter(k => k !== NO_THEME).length
  return (
    <>
      <div className="tr-legend" aria-hidden>
        <span>Tickets:</span>{BINS.map((b, i) => <span key={b}><i className={`tr-cell c${i + 1}`} />{b}</span>)}
        <span><i className="tr-cell c0" />nunca atendeu</span>
      </div>
      <div className="table-wrap tr-matrix-wrap">
        <table className="tr-matrix">
          <thead>
            <tr>
              <th className="tr-mx-theme">Tema</th>
              {techs.map(s => <th key={s.id} className="tr-mx-tech" title={s.name}><button type="button" onClick={() => onPick(s.id)}>{shortName(s.name)}</button></th>)}
              <th className="tr-mx-tot">Total</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.name}>
                <tr className="tr-mx-group"><th colSpan={techs.length + 2}>{g.name} <span>{g.n}</span></th></tr>
                {g.themes.map(([k, rs]) => {
                  const byTech = group(rs, r => r.techs)
                  const inf = rs.filter(r => r.source === 'inferido').length
                  return (
                    <tr key={k}>
                      <th className="tr-mx-theme" title={themeFull(k)}>{themeParts(k).main}{inf > 0 && <i className="tr-inf" title={`${inf} inferido(s) pelo título`}>◆</i>}</th>
                      {techs.map(s => {
                        const l = byTech.get(s.id) ?? []
                        return (
                          <td key={s.id} className={`tr-cell c${bin(l.length)}`} onClick={() => onPick(s.id)}
                            {...tipProps(setTip, () => l.length
                              ? <><b>{s.name}</b><br />{themeFull(k)}: {l.length} ticket(s) ({pct(l.length, s.n)}% dos dele)<br />Empresas: {byCount(group(l, r => r.entity)).slice(0, 3).map(([e, x]) => `${shortEntity(e)} (${x.length})`).join(', ')}</>
                              : <><b>{s.name}</b><br />Não atendeu {themeFull(k)} no período</>)}>
                            {l.length || ''}
                          </td>
                        )
                      })}
                      <td className="tr-mx-tot">{rs.length}</td>
                    </tr>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr><th className="tr-mx-theme">Temas cobertos</th>{techs.map(s => <td key={s.id}>{cover(s)}</td>)}<td /></tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

/* ---------- detalhe de um técnico ---------- */
function TechDetail({ s, name, openEntity, setOpenEntity }: { s: TechStat; name: (id: number) => string; openEntity: string | null; setOpenEntity: (e: string | null) => void }) {
  const [entLimit, setEntLimit] = useState(12)
  const [reqLimit, setReqLimit] = useState(12)
  const themes = byCount(s.themes)
  const entities = byCount(s.entities)
  const reqs = byCount(s.reqs)
  const topReq = reqs[0]
  const all = [...s.entities.values()].flat()
  const inferred = all.filter(r => r.source === 'inferido').length

  return (
    <div className="tr-detail">
      <section className="kpis pf-kpis tr-mini" aria-label={`Resumo de ${s.name}`}>
        <div className="kpi tone-gray"><span className="kpi-value">{s.n}</span><span className="kpi-label">Tickets atribuídos</span><span className="kpi-sub">{inferred ? `${inferred} com tema inferido` : 'todos com categoria do ITSM'}</span></div>
        <div className="kpi pf-kpi-par"><span className="kpi-value">{themes.filter(([k]) => k !== NO_THEME).length}</span><span className="kpi-label">Temas atendidos</span><span className="kpi-sub">{[...s.cats.keys()].filter(k => k !== NO_THEME).length} categorias distintas</span></div>
        <div className="kpi pf-kpi-tto"><span className="kpi-value">{s.entities.size}</span><span className="kpi-label">Empresas atendidas</span><span className="kpi-sub">principal: {entities[0] ? `${shortEntity(entities[0][0])} (${entities[0][1].length})` : '—'}</span></div>
        <div className="kpi pf-kpi-ttr"><span className="kpi-value">{s.reqs.size}</span><span className="kpi-label">Requerentes atendidos</span><span className="kpi-sub">mais atendido: {topReq ? <b>{name(topReq[0])}</b> : '—'}{topReq && ` (${topReq[1].length})`}</span></div>
      </section>

      <div className="pf-grid pf-grid-2">
        <Card title="Temas mais atendidos" hint="Nível 2 da categoria · passe o mouse para ver empresas, requerentes e problemas de cada tema">
          <HBars tone="qty" fmt={v => `${v} · ${pct(v, s.n)}%`} rows={themes.map(([k, rs]) => {
            const inf = rs.filter(r => r.source === 'inferido').length
            const pp = themeParts(k)
            return {
              id: k, label: pp.main, sub: pp.main === pp.group ? undefined : pp.group, value: rs.length,
              tip: <><b>{themeFull(k)}</b><br />{rs.length} ticket(s) · {pct(rs.length, s.n)}% dos tickets do técnico{inf ? ` · ${inf} inferido(s)` : ''}
                <br />Empresas: {byCount(group(rs, r => r.entity)).slice(0, 3).map(([e, x]) => `${shortEntity(e)} (${x.length})`).join(', ')}
                <br />Requerentes: {byCount(group(rs, r => r.reqs)).slice(0, 3).map(([id, x]) => `${name(id)} (${x.length})`).join(', ') || '—'}
                <br />Problemas: {byCount(group(rs, r => r.problem)).slice(0, 3).map(([p, x]) => `${problemParts(p).main} (${x.length})`).join(', ')}</>,
            }
          })} />
        </Card>
        <Card title="Empresas atendidas" hint="Clique numa empresa para ver os problemas recorrentes dela logo abaixo">
          <HBars tone="qty" fmt={v => String(v)} picked={openEntity} onPick={id => setOpenEntity(openEntity === id ? null : String(id))} rows={entities.map(([e, rs]) => ({
            id: e, label: shortEntity(e), value: rs.length,
            tip: <><b>{shortEntity(e)}</b><br />{rs.length} ticket(s) do técnico<br />Problemas: {byCount(group(rs, r => r.problem)).slice(0, 3).map(([p, x]) => `${problemParts(p).main} (${x.length})`).join(', ')}</>,
          }))} />
        </Card>
      </div>

      <Card title="Problemas mais recorrentes nas empresas que ele atendeu" hint="Problema = categoria mais específica do ticket (nível 3; sem nível 3, o tema). Clique na linha para ver todos os problemas e os tickets.">
        <div className="table-wrap">
          <table className="grid pf-table tr-prob">
            <thead><tr><th className="left">Empresa</th><th className="num">Tickets</th><th className="left">Problemas mais recorrentes</th></tr></thead>
            <tbody>
              {entities.slice(0, Math.max(entLimit, openEntity ? entities.findIndex(([e]) => e === openEntity) + 1 : 0)).map(([e, rs]) => {
                const probs = byCount(group(rs, r => r.problem))
                const open = openEntity === e
                return (
                  <Fragment key={e}>
                    <tr className={open ? 'on' : ''} onClick={() => setOpenEntity(open ? null : e)}>
                      <td className="left"><button type="button" className="link" aria-expanded={open} onClick={ev => { ev.stopPropagation(); setOpenEntity(open ? null : e) }}>{open ? '▾' : '▸'} {shortEntity(e)}</button></td>
                      <td className="num">{rs.length}</td>
                      <td className="left tr-wrap"><div className="tr-chips">{probs.slice(0, 3).map(([p, x]) => <span key={p} className="pf-chip" title={problemParts(p).group}>{problemParts(p).main} <b>×{x.length}</b></span>)}{probs.length > 3 && <span className="muted">+{probs.length - 3}</span>}</div></td>
                    </tr>
                    {open && (
                      <tr className="tr-open"><td colSpan={3} className="left tr-wrap">
                        <ul className="tr-plist">
                          {probs.map(([p, x]) => (
                            <li key={p}>
                              <span className="tr-pname"><b>{problemParts(p).main}</b> <small>{problemParts(p).group}</small></span>
                              <span className="tr-pn">{x.length}</span>
                              <span className="tr-tks">{x.map(r => <a key={r.t.id} href={r.t.url} target="_blank" rel="noreferrer" title={`${r.t.title} · ${formatDate(r.t.openedAtUtc)} · requerente: ${r.reqs.map(name).join(', ') || '—'}${r.source === 'inferido' ? ` · tema inferido (${r.t.confidence}%)` : ''}`}>#{r.t.id}{r.source === 'inferido' && <i className="tr-inf">◆</i>}</a>)}</span>
                            </li>
                          ))}
                        </ul>
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {entities.length > entLimit && <button type="button" className="pf-more" onClick={() => setEntLimit(l => l + 20)}>Mostrar mais empresas ({entities.length - entLimit} restantes)</button>}
      </Card>

      <div className="pf-grid pf-grid-2">
        <Card title="Categorias atendidas pelo menos uma vez" hint="Categorias exatamente como registradas no ITSM, agrupadas pelo 1º nível">
          <CatTree cats={s.cats} />
        </Card>
        <Card title="Requerentes atendidos" hint="Quem abriu os tickets que o técnico atendeu">
          {topReq && (
            <div className="pf-peak tr-top">
              <div className="pf-peak-head"><b>Mais atendido: {name(topReq[0])}</b><span>{topReq[1].length} ticket(s) · {pct(topReq[1].length, s.n)}%</span></div>
              <div className="pf-cl-meta">{byCount(group(topReq[1], r => r.entity)).slice(0, 2).map(([e]) => shortEntity(e)).join(', ')} · temas: {byCount(group(topReq[1], r => r.theme)).slice(0, 3).map(([k, x]) => `${themeParts(k).main} (${x.length})`).join(', ')}</div>
            </div>
          )}
          <HBars tone="qty" fmt={v => String(v)} rows={reqs.slice(0, reqLimit).map(([id, rs]) => ({
            id, label: name(id), sub: byCount(group(rs, r => r.entity))[0] ? shortEntity(byCount(group(rs, r => r.entity))[0]![0]) : undefined, value: rs.length,
            tip: <><b>{name(id)}</b><br />{rs.length} ticket(s) atendido(s) por {s.name}<br />Temas: {byCount(group(rs, r => r.theme)).slice(0, 3).map(([k, x]) => `${themeFull(k)} (${x.length})`).join(', ')}</>,
          }))} />
          {reqs.length > reqLimit && <button type="button" className="pf-more" onClick={() => setReqLimit(l => l + 30)}>Mostrar mais ({reqs.length - reqLimit} restantes)</button>}
        </Card>
      </div>
    </div>
  )
}

function CatTree({ cats }: { cats: Map<string, number> }): ReactNode {
  const groups = new Map<string, { n: number; items: [string, number][] }>()
  for (const [c, n] of cats) {
    const p = c === NO_THEME ? ['Sem categoria'] : parts(c)
    const g = groups.get(p[0]!) ?? { n: 0, items: [] }
    g.n += n; g.items.push([p.length > 1 ? p.slice(1).join(' › ') : '(só o 1º nível)', n]); groups.set(p[0]!, g)
  }
  const list = [...groups.entries()].sort((a, b) => (a[0] === 'Sem categoria' ? 1 : b[0] === 'Sem categoria' ? -1 : b[1].n - a[1].n))
  return (
    <div className="tr-tree">
      {list.map(([g, v]) => (
        <div key={g} className="tr-tree-g">
          <div className="tr-tree-h"><b>{g}</b><span>{v.n}</span></div>
          <ul>{v.items.sort((a, b) => b[1] - a[1]).map(([c, n]) => <li key={c}><span>{c}</span><span>{n}</span></li>)}</ul>
        </div>
      ))}
    </div>
  )
}

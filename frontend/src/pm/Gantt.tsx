import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PmMeta, PmProjectView, PmTask } from './types'
import { addDays, DAY, depCode, diffDays, fmt, MILESTONE_STATE, toIso, toMs } from './util'

const LEFT = 330          // coluna fixa (Nº + tarefa)
const ROW = 34
const ZOOMS = [{ id: 'dia', label: 'Dias', w: 28 }, { id: 'semana', label: 'Compacto', w: 16 }, { id: 'mes', label: 'Meses', w: 5 }] as const
type ZoomId = typeof ZOOMS[number]['id']
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const WD = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

/** Intervalo do gráfico: do 1º dia do mês de início até 24 meses depois do fim do projeto (fim do mês). */
export function ganttRange(view: PmProjectView, monthsAfter = 24) {
  const dates = [view.project.startDate, view.project.endDate, view.today,
    ...view.tasks.flatMap(t => [t.planStart, t.planEnd, t.realStart, t.realEnd]), ...view.milestones.map(m => m.dueDate)]
    .filter((d): d is string => !!d).sort()
  const first = dates[0]!, last = dates[dates.length - 1]!
  const start = `${first.slice(0, 7)}-01`
  const endBase = last > view.project.endDate ? last : view.project.endDate
  const e = new Date(toMs(endBase)); const endMonth = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + monthsAfter + 1, 0))
  return { start, end: toIso(endMonth.getTime()) }
}

export function months(start: string, end: string) {
  const list: { iso: string; days: number; offset: number; label: string }[] = []
  let d = new Date(toMs(start))
  while (toIso(d.getTime()) <= end) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    const iso = toIso(d.getTime())
    list.push({ iso, days: Math.round((Math.min(next.getTime(), toMs(end) + DAY) - d.getTime()) / DAY), offset: diffDays(start, iso), label: monthFmt.format(d).replace('.', '').replace(' de ', ' ') })
    d = next
  }
  return list
}

export default function Gantt({ view, meta, entityName, onOpen }: { view: PmProjectView; meta: PmMeta; entityName: string; onOpen: (id: number) => void }) {
  const [zoom, setZoom] = useState<ZoomId>(() => { try { return (localStorage.getItem('pm.gantt.zoom') as ZoomId) || 'dia' } catch { return 'dia' } })
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState<string | null>(null)
  const dayW = ZOOMS.find(z => z.id === zoom)!.w
  const scroll = useRef<HTMLDivElement>(null)

  const { start, end } = useMemo(() => ganttRange(view), [view])
  const totalDays = diffDays(start, end) + 1
  const width = totalDays * dayW
  const mons = useMemo(() => months(start, end), [start, end])
  const x = (iso: string) => diffDays(start, iso) * dayW
  const tasks = view.tasks
  const rowOf = useMemo(() => new Map(tasks.map((t, i) => [t.id, i + 1])), [tasks]) // linha 0 = marcos
  const height = (tasks.length + 1) * ROW
  const firstWeekday = new Date(toMs(start)).getUTCDay()

  const scrollTo = (iso: string) => {
    const el = scroll.current; if (!el) return
    el.scrollLeft = Math.max(0, x(iso) - 3 * dayW)
  }
  // abre no início do projeto (ou em hoje, se o projeto já começou)
  useLayoutEffect(() => {
    scrollTo(view.today > view.project.startDate && view.today <= view.project.endDate ? addDays(view.today, -7) : view.project.startDate)
  }, [zoom]) // eslint-disable-line react-hooks/exhaustive-deps

  const setZ = (z: ZoomId) => { setZoom(z); try { localStorage.setItem('pm.gantt.zoom', z) } catch { /* sem storage */ } }
  const exportPdf = async () => {
    setExporting(true); setExportErr(null)
    try { const { exportGanttPdf } = await import('./ganttPdf'); exportGanttPdf(view, meta, entityName) }
    catch (e) { setExportErr(e instanceof Error ? e.message : String(e)) }
    finally { setExporting(false) }
  }

  const barEnd = (iso: string) => x(iso) + dayW // fim inclusivo

  // âncoras das setas (barra planejada)
  const anchor = (t: PmTask, side: 'start' | 'end') => {
    const r = rowOf.get(t.id)!
    const s = t.planStart ?? t.realStart, e = t.planEnd ?? t.realEnd ?? s
    if (!s || !e) return null
    return { x: side === 'start' ? x(s) : barEnd(e), y: r * ROW + 11 }
  }
  const byId = new Map(tasks.map(t => [t.id, t]))

  return (
    <section className="panel gantt">
      <header className="panel-head row">
        <div>
          <h2>Gráfico de Gantt</h2>
          <p>Barra de cima = <b>planejado</b> (parte escura = % realizado) · barra de baixo = <b>executado</b>. Linha vermelha = hoje. Mostra até 24 meses após o fim do projeto.</p>
        </div>
        <div className="actions">
          <div className="seg" role="group" aria-label="Zoom">
            {ZOOMS.map(z => <button key={z.id} type="button" className={zoom === z.id ? 'on' : ''} aria-pressed={zoom === z.id} onClick={() => setZ(z.id)}>{z.label}</button>)}
          </div>
          <button type="button" onClick={() => scrollTo(addDays(view.today, -7))}>Hoje</button>
          <button type="button" onClick={() => scrollTo(view.project.startDate)}>Início do projeto</button>
          <button type="button" className="primary" onClick={exportPdf} disabled={exporting}>{exporting ? 'Gerando PDF…' : '⤓ Exportar PDF'}</button>
        </div>
      </header>
      {exportErr && <div className="banner error">Falha ao gerar o PDF: {exportErr}</div>}

      <div className="g-legend" aria-hidden>
        <span><i className="lg-plan" /> Planejado</span>
        <span><i className="lg-plan prog" /> % realizado</span>
        <span><i className="lg-real" /> Executado</span>
        <span><i className="lg-real late" /> Executando com atraso</span>
        <span><i className="lg-real done" /> Concluída ✓</span>
        <span><i className="lg-sum" /> Tarefa-resumo</span>
        <span><b className="lg-ms">◆</b> Marco</span>
        <span><i className="lg-today" /> Hoje</span>
        <span><i className="lg-proj" /> Início/fim do projeto</span>
        <span>→ Dependência (vermelha = não respeitada)</span>
      </div>

      <div className="g-scroll" ref={scroll}>
        <div className="g-inner" style={{ width: LEFT + width }}>
          {/* cabeçalho */}
          <div className="g-head" style={{ width: LEFT + width }}>
            <div className="g-left g-left-head"><span className="g-num">Nº</span><span>Tarefa</span></div>
            <div className="g-time" style={{ width }}>
              <div className="g-months">
                {mons.map(m => <div key={m.iso} className="g-month" style={{ left: m.offset * dayW, width: m.days * dayW }}><span>{m.label}</span></div>)}
              </div>
              <div className="g-days">
                {dayW >= 14 && Array.from({ length: totalDays }, (_, i) => {
                  const d = new Date(toMs(start) + i * DAY), wd = d.getUTCDay(), iso = toIso(d.getTime())
                  return (
                    <div key={i} className={`g-day${wd === 0 || wd === 6 ? ' we' : ''}${iso === view.today ? ' today' : ''}`} style={{ left: i * dayW, width: dayW }} title={fmt(iso)}>
                      {dayW >= 22 && <small>{WD[wd]}</small>}{d.getUTCDate()}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* corpo */}
          <div className="g-body" style={{ height }}>
            <div className="g-bg" style={{
              left: LEFT, width, height,
              // bloco de 7 dias, um trecho por dia (sábado/domingo sombreados), repetido na horizontal
              backgroundImage: dayW >= 5 ? `linear-gradient(90deg, ${Array.from({ length: 7 }, (_, i) => {
                const wd = (firstWeekday + i) % 7
                return `${wd === 0 || wd === 6 ? 'var(--g-we)' : 'transparent'} ${i * dayW}px ${(i + 1) * dayW}px`
              }).join(', ')})` : undefined,
              backgroundSize: `${7 * dayW}px 100%`,
              backgroundRepeat: 'repeat-x',
            }}>
              {mons.map(m => <span key={m.iso} className="g-mline" style={{ left: m.offset * dayW }} />)}
              <span className="g-proj" style={{ left: x(view.project.startDate) }} title={`Início do projeto ${fmt(view.project.startDate)}`} />
              <span className="g-proj" style={{ left: barEnd(view.project.endDate) }} title={`Fim do projeto ${fmt(view.project.endDate)}`} />
              {view.milestones.map(m => <span key={m.id} className={`g-msline tone-${MILESTONE_STATE[m.state]?.tone}`} style={{ left: x(m.dueDate) + dayW / 2 }} />)}
              <span className="g-today" style={{ left: x(view.today) + dayW / 2 }} title={`Hoje ${fmt(view.today)}`} />
            </div>

            {/* linha de marcos */}
            <div className="g-row g-row-ms" style={{ top: 0 }}>
              <div className="g-left"><span className="g-num">◆</span><span className="g-name">Marcos</span></div>
              {view.milestones.map(m => {
                const s = MILESTONE_STATE[m.state]!
                return (
                  <div key={m.id} className={`g-ms tone-${s.tone}`} style={{ left: LEFT + x(m.dueDate) + dayW / 2 }}
                    title={`${m.name} — meta ${fmt(m.dueDate)} · ${s.label}${m.forecast ? ` · previsão ${fmt(m.forecast)}` : ''}${m.objective ? `\nObjetivo: ${m.objective}` : ''}`}>
                    <b>◆</b><span>{m.name}</span>
                  </div>
                )
              })}
            </div>

            {tasks.map((t, i) => {
              const top = (i + 1) * ROW
              const ps = t.planStart, pe = t.planEnd
              const rs = t.realStart, re = t.realEnd ?? (rs && !t.done ? view.today : null)
              const lateRun = !t.done && !!rs && !!pe && view.today > pe
              const tip = `${t.wbs} ${t.title}\nPlanejado: ${fmt(ps)} → ${fmt(pe)}\nExecutado: ${fmt(rs)} → ${t.realEnd ? fmt(t.realEnd) : rs ? 'em andamento' : '—'}\nRealizado ${Math.round(t.progress)}%${t.expected !== null ? ` · previsto ${Math.round(t.expected)}%` : ''}${t.assignees.length ? `\nResponsáveis: ${t.assignees.map(a => a.name).join(', ')}` : ''}`
              return (
                <div key={t.id} className={`g-row${t.isSummary ? ' summary' : ''}${t.done ? ' done' : ''}`} style={{ top }}>
                  <button type="button" className="g-left" onClick={() => onOpen(t.id)} title={tip}>
                    <span className="g-num">{t.wbs}</span>
                    <span className="g-name" style={{ paddingLeft: t.level * 14 }}>{t.done && <span className="pm-ok">✓ </span>}{t.title}</span>
                  </button>
                  {ps && pe && (
                    <div className={`g-plan${t.isSummary ? ' sum' : ''}${t.late ? ' late' : ''}`} style={{ left: LEFT + x(ps), width: Math.max(dayW, barEnd(pe) - x(ps)) }} title={tip}>
                      {!t.isSummary && <span className="g-prog" style={{ width: `${Math.min(100, t.progress)}%` }} />}
                    </div>
                  )}
                  {rs && re && (
                    <div className={`g-real${t.done ? ' done' : lateRun ? ' late' : ''}${t.isSummary ? ' sum' : ''}`} style={{ left: LEFT + x(rs), width: Math.max(dayW / 2, barEnd(re) - x(rs)) }} title={tip} />
                  )}
                  {(pe || re) && (
                    <span className="g-label" style={{ left: LEFT + Math.max(pe ? barEnd(pe) : 0, re ? barEnd(re) : 0) + 6 }}>
                      {t.done ? <b className="pm-ok">✓ {fmt(t.realEnd)}</b> : `${Math.round(t.progress)}%`}
                      {t.assignees.length > 0 && <span className="pm-muted"> · {t.assignees.map(a => a.name.split(' ')[0]).join(', ')}</span>}
                    </span>
                  )}
                </div>
              )
            })}

            <svg className="g-arrows" style={{ left: LEFT }} width={width} height={height} aria-hidden>
              <defs>
                <marker id="g-ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--g-arrow)" /></marker>
                <marker id="g-ar-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--red)" /></marker>
              </defs>
              {view.dependencies.map(d => {
                const p = byId.get(d.predId), s = byId.get(d.succId)
                if (!p || !s) return null
                const from = anchor(p, d.type === 1 || d.type === 3 ? 'start' : 'end')
                const to = anchor(s, d.type === 0 || d.type === 1 ? 'start' : 'end')
                if (!from || !to) return null
                const out = d.type === 1 || d.type === 3 ? -8 : 8
                const into = d.type === 0 || d.type === 1 ? -8 : 8
                const x1 = from.x + out, x2 = to.x + into
                const midY = to.y > from.y ? to.y - ROW / 2 + 4 : to.y + ROW / 2 - 4
                const path = (out > 0 ? x2 >= x1 : x2 <= x1) || from.y === to.y
                  ? `M${from.x},${from.y} H${x1} V${to.y} H${to.x}`
                  : `M${from.x},${from.y} H${x1} V${midY} H${x2} V${to.y} H${to.x}`
                return <path key={d.id} d={path} className={d.violated ? 'bad' : ''} markerEnd={`url(#${d.violated ? 'g-ar-bad' : 'g-ar'})`}><title>{`${p.wbs} → ${s.wbs} (${depCode(d.type, d.lagDays)})${d.violated ? ' — não respeitada' : ''}`}</title></path>
              })}
            </svg>
          </div>
        </div>
      </div>
      {tasks.length === 0 && <p className="empty">Adicione tarefas com datas planejadas na aba Tarefas para montar o Gantt.</p>}
    </section>
  )
}

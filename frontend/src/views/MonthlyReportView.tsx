import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MonthlyReportResponse } from '../types'
import { shortEntity } from '../entity'
import { apiUrl, formatDate } from '../format'

const PERIODS = [3, 6, 12, 24]
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const monthLabel = (ym: string) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`)).replace('.', '').replace(' de ', '/')

export default function MonthlyReportView({ filter }: { filter: string }) {
  const [months, setMonths] = useState(() => { try { return Number(localStorage.getItem('report.months')) || 12 } catch { return 12 } })
  const [data, setData] = useState<MonthlyReportResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(apiUrl(`/api/reports/monthly?months=${months}${refresh ? '&refresh=true' : ''}`), { credentials: 'same-origin' })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.errors?.join(' ') ?? `HTTP ${res.status}`)
      setData(body as MonthlyReportResponse)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }, [months])

  useEffect(() => { void load(false) }, [load])
  useEffect(() => { try { localStorage.setItem('report.months', String(months)) } catch { /* sem storage */ } }, [months])

  const rep = data?.report ?? null
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (rep?.rows ?? []).filter(r => !q || r.entity.toLowerCase().includes(q))
  }, [rep, filter])
  const totals = useMemo(() => rep ? rep.months.map((_, i) => rows.reduce((s, r) => s + r.counts[i]!, 0)) : [], [rep, rows])
  const grand = totals.reduce((a, b) => a + b, 0)
  const max = Math.max(1, ...rows.flatMap(r => r.counts))

  const exportCsv = () => {
    if (!rep) return
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
    const lines = [
      ['Entidade', 'Entidade (completa)', ...rep.months, 'Total'].map(esc).join(';'),
      ...rows.map(r => [esc(shortEntity(r.entity)), esc(r.entity), ...r.counts.map(String), String(r.total)].join(';')),
      [esc('Total'), esc(''), ...totals.map(String), String(grand)].join(';'),
    ]
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `tickets-por-entidade-${rep.months[0]}_${rep.months[rep.months.length - 1]}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <section className="panel">
      <header className="panel-head row">
        <div>
          <h2>Tickets abertos por entidade / mês</h2>
          <p>
            Contagem pela data de abertura (fuso do ITSM). Inclui todos os status; tickets na lixeira não entram.
            {rep && <> · Gerado em {formatDate(rep.generatedAtUtc)} ({(rep.durationMs / 1000).toFixed(1)}s)</>}
          </p>
        </div>
        <div className="actions">
          <div className="seg">
            {PERIODS.map(p => <button key={p} className={months === p ? 'on' : ''} onClick={() => setMonths(p)}>{p} meses</button>)}
          </div>
          <button onClick={exportCsv} disabled={!rep || rows.length === 0}>Exportar CSV</button>
          <button className="primary" onClick={() => load(true)} disabled={loading}>{loading ? 'Carregando…' : '⟳ Atualizar'}</button>
        </div>
      </header>

      {error && <div className="banner error">Falha ao gerar o relatório: {error}</div>}
      {data?.error && <div className="banner error">Falha ao consultar o ITSM: {data.error}{rep && ' — exibindo o último relatório gerado.'}</div>}
      {data?.throttledSeconds && <div className="banner info">Atualização limitada a 1 a cada {data.throttledSeconds}s — exibindo o último relatório.</div>}
      {!rep && loading && <p className="empty center">Gerando relatório…</p>}

      {rep && (
        <>
          <section className="kpis">
            <div className="kpi tone-blue"><span className="kpi-value">{grand}</span><span className="kpi-label">Tickets no período</span></div>
            <div className="kpi tone-gray"><span className="kpi-value">{rows.length}</span><span className="kpi-label">Entidades com tickets</span></div>
            <div className="kpi tone-green"><span className="kpi-value">{rep.months.length ? Math.round(grand / rep.months.length) : 0}</span><span className="kpi-label">Média por mês</span></div>
            <div className="kpi tone-amber"><span className="kpi-value">{totals[totals.length - 1] ?? 0}</span><span className="kpi-label">Mês atual ({monthLabel(rep.months[rep.months.length - 1]!)}) · parcial</span></div>
          </section>
          <div className="table-wrap report">
            <table className="grid heat">
              <thead>
                <tr>
                  <th className="left sticky">Entidade</th>
                  {rep.months.map(m => <th key={m}>{monthLabel(m)}</th>)}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.entity}>
                    <td className="left sticky" title={r.entity}>{shortEntity(r.entity)}</td>
                    {r.counts.map((c, i) => (
                      <td key={i} className={c ? '' : 'zero'} style={c ? { background: `color-mix(in srgb, var(--blue) ${Math.round(8 + (c / max) * 47)}%, transparent)` } : undefined}>{c}</td>
                    ))}
                    <td className="strong">{r.total}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={rep.months.length + 2} className="empty">Nenhum ticket no período.</td></tr>}
              </tbody>
              <tfoot>
                <tr>
                  <td className="left sticky">Total</td>
                  {totals.map((t, i) => <td key={i}>{t}</td>)}
                  <td>{grand}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

import { useMemo, useState } from 'react'
import type { BoardSnapshot, BoardTicket } from '../types'
import { COLUMN_LABELS, COLUMN_TONES, entityKey, placedTickets, shortEntity, type BoardColumnKey } from '../entity'
import { formatDate, formatDuration, hoursBetween } from '../format'

const COLS: BoardColumnKey[] = ['unassigned', 'inProgress', 'blocked', 'completed', 'cancelled']
const SHORT: Record<BoardColumnKey, string> = { unassigned: 'S/ atrib.', inProgress: 'Andam.', blocked: 'Bloq.', completed: 'Compl.', cancelled: 'Canc.' }

type Props = { snap: BoardSnapshot; match: (t: BoardTicket) => boolean; now: Date; selected: Set<string> | null; onSelect: (s: Set<string> | null) => void }

export default function EntitiesView({ snap, match, now, selected, onSelect }: Props) {
  const single = selected?.size === 1 ? [...selected][0]! : null
  // clique: só esta entidade (ou volta a todas); Ctrl/⌘+clique: adiciona/remove da seleção
  const pick = (name: string, multi: boolean) => {
    if (multi) {
      const s = new Set(selected ?? [])
      if (s.has(name)) s.delete(name); else s.add(name)
      onSelect(s.size ? s : null)
    } else onSelect(single === name ? null : new Set([name]))
  }
  const [col, setCol] = useState<BoardColumnKey | ''>('')
  const placed = useMemo(() => placedTickets(snap), [snap])
  const visible = useMemo(() => placed.filter(p => match(p.ticket)), [placed, match])

  const summary = useMemo(() => {
    const m = new Map<string, Record<BoardColumnKey, number> & { total: number }>()
    for (const p of visible) {
      const k = entityKey(p.ticket)
      const r = m.get(k) ?? { unassigned: 0, inProgress: 0, blocked: 0, completed: 0, cancelled: 0, total: 0 }
      r[p.column]++; r.total++
      m.set(k, r)
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
  }, [visible])

  const list = visible
    .filter(p => (selected === null || selected.has(entityKey(p.ticket))) && (!col || p.column === col))
    .sort((a, b) => COLS.indexOf(a.column) - COLS.indexOf(b.column) || (a.ticket.openedAtUtc ?? '').localeCompare(b.ticket.openedAtUtc ?? ''))

  const cols = COLS.filter(c => c !== 'cancelled' || snap.cancelledConfigured)

  return (
    <div className="split">
      <section className="panel">
        <header className="panel-head">
          <h2>Entidades <span className="muted">({summary.length})</span></h2>
          <p>Tickets abertos + solucionados nos últimos {snap.doneDays} dias. Clique numa linha para filtrar · Ctrl+clique para selecionar várias.</p>
        </header>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th className="left">Entidade</th>
                {cols.map(c => <th key={c} className={`tone-${COLUMN_TONES[c]}`} title={COLUMN_LABELS[c]}><span className="th-dot" />{SHORT[c]}</th>)}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {summary.map(([name, r]) => (
                <tr key={name} className={selected?.has(name) ? 'selected' : ''} onClick={e => pick(name, e.ctrlKey || e.metaKey)}>
                  <td className="left" title={name}>{shortEntity(name)}</td>
                  {cols.map(c => <td key={c} className={r[c] ? '' : 'zero'}>{r[c]}</td>)}
                  <td className="strong">{r.total}</td>
                </tr>
              ))}
              {summary.length === 0 && <tr><td colSpan={cols.length + 2} className="empty">Nenhum ticket.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <header className="panel-head row">
          <div>
            <h2>{selected === null ? 'Todos os tickets' : single ? shortEntity(single) : `${selected.size} entidades selecionadas`} <span className="muted">({list.length})</span></h2>
            {single && <p title={single}>{single}</p>}
          </div>
          <div className="seg">
            <button className={col === '' ? 'on' : ''} onClick={() => setCol('')}>Todos</button>
            {cols.map(c => <button key={c} className={col === c ? 'on' : ''} onClick={() => setCol(c)}>{COLUMN_LABELS[c]}</button>)}
          </div>
        </header>
        <div className="table-wrap">
          <table className="grid tickets">
            <thead>
              <tr><th className="left">#</th><th className="left">Título</th><th className="left">Entidade</th><th className="left">Situação</th><th className="left">Técnico</th><th>Abertura</th><th>Tempo</th></tr>
            </thead>
            <tbody>
              {list.map(({ ticket: t, column }) => {
                const end = column === 'completed' || column === 'cancelled' ? (t.solvedAtUtc ?? t.closedAtUtc) : null
                const age = end ? hoursBetween(t.openedAtUtc, new Date(end)) : hoursBetween(t.openedAtUtc, now)
                return (
                  <tr key={t.id}>
                    <td className="left"><a className="id" href={t.url} target="_blank" rel="noopener noreferrer">#{t.id}</a></td>
                    <td className="left title" title={t.title}>{t.title}</td>
                    <td className="left" title={t.entity ?? ''}>{shortEntity(t.entity)}</td>
                    <td className="left"><span className={`tag tone-${COLUMN_TONES[column]}`}>{COLUMN_LABELS[column]}</span></td>
                    <td className="left">{t.technicians.length ? t.technicians.map(x => x.name).join(', ') : <i className="muted">—</i>}</td>
                    <td>{formatDate(t.openedAtUtc)}</td>
                    <td title={end ? 'Abertura até a solução' : 'Aberto há'}>{formatDuration(age)}</td>
                  </tr>
                )
              })}
              {list.length === 0 && <tr><td colSpan={7} className="empty">Nenhum ticket.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

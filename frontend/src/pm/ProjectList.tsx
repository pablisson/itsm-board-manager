import { useCallback, useEffect, useMemo, useState } from 'react'
import { shortEntity } from '../entity'
import { pm } from './api'
import { go } from './route'
import ProgressPair from './ProgressPair'
import ProjectForm from './ProjectForm'
import type { PmMeta, PmProjectListItem, PmProjectView } from './types'
import { fmt } from './util'

export default function ProjectList({ meta, entity }: { meta: PmMeta; entity: number | null }) {
  const [items, setItems] = useState<PmProjectListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    try { setItems(await pm<PmProjectListItem[]>('GET', '/projects')); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const rows = useMemo(() => (items ?? []).filter(i =>
    (entity === null || i.project.entityId === entity) &&
    (!q.trim() || `${i.project.name} ${i.project.entityName ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [items, entity, q])
  const entName = (id: number, fallback: string | null) => shortEntity(meta.entities.find(e => e.id === id)?.name ?? fallback)

  return (
    <section className="panel">
      <header className="panel-head row">
        <div>
          <h2>Projetos{entity !== null && <> · {entName(entity, null)}</>}</h2>
          <p>Escolha um projeto para ver as tarefas e o Gantt. “Previsto” = quanto deveria estar pronto hoje pelo planejado.</p>
        </div>
        <div className="actions">
          <input type="search" placeholder="Buscar projeto…" value={q} onChange={e => setQ(e.target.value)} />
          <button type="button" className="primary" onClick={() => setCreating(true)}>+ Novo projeto</button>
        </div>
      </header>
      {error && <div className="banner error">{error}</div>}
      {!items && !error && <p className="empty center">Carregando…</p>}
      {items && (
        <div className="table-wrap">
          <table className="grid pm-list">
            <thead>
              <tr>
                <th className="left">Projeto</th><th className="left">Entidade</th><th>Início</th><th>Fim</th><th>Término previsto</th>
                <th className="left">Realizado / previsto</th><th>Tarefas</th><th>Atrasadas</th><th>Marcos</th><th>ITSM</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ project: p, summary: s }) => {
                const slip = !!s.forecast && s.forecast > p.endDate
                return (
                  <tr key={p.id} onClick={() => go(p.id)} className="clickable">
                    <td className="left strong"><a href={`#pm/${p.id}`} onClick={e => e.stopPropagation()}>{p.name}</a></td>
                    <td className="left" title={p.entityName ?? ''}>{entName(p.entityId, p.entityName)}</td>
                    <td>{fmt(p.startDate)}</td><td>{fmt(p.endDate)}</td>
                    <td className={slip ? 'pm-bad' : ''} title={slip ? 'A previsão passa do fim do projeto' : ''}>{fmt(s.forecast)}</td>
                    <td className="left"><ProgressPair progress={s.progress} expected={s.expected} /></td>
                    <td>{s.done}/{s.tasks}</td>
                    <td className={s.late ? 'pm-bad' : 'zero'}>{s.late}</td>
                    <td>{s.milestonesDone}/{s.milestones}</td>
                    <td>{p.glpiProjectId ? `#${p.glpiProjectId}` : '—'}</td>
                  </tr>
                )
              })}
              {rows.length === 0 && <tr><td colSpan={10} className="empty">{items.length ? 'Nenhum projeto com esse filtro.' : 'Nenhum projeto ainda. Crie o primeiro em “+ Novo projeto”.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <ProjectForm meta={meta} defaultEntity={entity} onClose={() => setCreating(false)}
          onSave={async v => { const r = await pm<PmProjectView>('POST', '/projects', v); setCreating(false); go(r.project.id) }} />
      )}
    </section>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { shortEntity } from '../entity'
import { pm } from './api'
import { go, type PmTab } from './route'
import Gantt from './Gantt'
import Milestones from './Milestones'
import ProgressPair from './ProgressPair'
import ProjectForm from './ProjectForm'
import TaskDrawer from './TaskDrawer'
import TaskGrid from './TaskGrid'
import type { PmMeta, PmProjectView } from './types'
import { diffDays, fmt, fmtLong, pct } from './util'

export type Run = <T = PmProjectView>(method: string, path: string, body?: unknown) => Promise<T | null>
export interface PmCtx { view: PmProjectView; meta: PmMeta; run: Run; busy: boolean; apply: (v: PmProjectView) => void }

export default function ProjectView({ id, tab, meta }: { id: number; tab: PmTab; meta: PmMeta }) {
  const [view, setView] = useState<PmProjectView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [drawer, setDrawer] = useState<{ id: number; section?: string } | null>(null)

  const apply = useCallback((v: PmProjectView) => { setView(v); if (v.messages?.length) setNotice(v.messages) }, [])
  const load = useCallback(async () => {
    try { apply(await pm<PmProjectView>('GET', `/projects/${id}`)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [id, apply])
  useEffect(() => { void load() }, [load])

  const run: Run = useCallback(async <T,>(method: string, path: string, body?: unknown) => {
    setBusy(true)
    try {
      const r = await pm<T>(method, path, body)
      const v = (r && typeof r === 'object' && 'view' in r ? (r as { view: PmProjectView }).view : r) as PmProjectView | undefined
      if (v && typeof v === 'object' && 'tasks' in v) apply(v)
      setError(null)
      return r
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally { setBusy(false) }
  }, [apply]) as Run

  // mensagens somem sozinhas
  useEffect(() => { if (!notice.length) return; const t = setTimeout(() => setNotice([]), 8000); return () => clearTimeout(t) }, [notice])

  if (!view) return error ? <div className="banner error">{error} <button className="link" onClick={() => go(null)}>Voltar aos projetos</button></div> : <p className="empty center">Carregando projeto…</p>

  const p = view.project, s = view.summary
  const ctx: PmCtx = { view, meta, run, busy, apply }
  const gap = s.expected === null ? null : s.progress - s.expected
  const slip = s.forecast ? diffDays(p.endDate, s.forecast) : 0
  const syncing = busy

  const removeProject = async () => {
    if (!confirm(`Excluir o projeto “${p.name}” com todas as tarefas, anexos e marcos?\n\nItens já criados no ITSM não são apagados.`)) return
    if (await run('DELETE', `/projects/${p.id}`) !== null) go(null)
  }

  return (
    <>
      <section className="panel pm-head">
        <div className="pm-head-top">
          <div className="pm-head-title">
            <button type="button" className="link pm-back" onClick={() => go(null)}>← Projetos</button>
            <h2>{p.name}</h2>
            <p className="meta">
              <span title={p.entityName ?? ''}>🏢 {shortEntity(meta.entities.find(e => e.id === p.entityId)?.name ?? p.entityName)}</span>
              {' · '}📅 {fmtLong(p.startDate)} a {fmtLong(p.endDate)} ({diffDays(p.startDate, p.endDate) + 1} dias)
              {p.glpiProjectId && <> · ITSM: projeto #{p.glpiProjectId}</>}
            </p>
            {p.description && <p className="pm-desc">{p.description}</p>}
          </div>
          <div className="actions">
            <button type="button" onClick={() => setEditing(true)}>✎ Editar projeto</button>
            <button type="button" disabled={syncing || !view.tasks.length} onClick={() => run('POST', `/projects/${p.id}/glpi/link-all`)}
              title="Cria no ITSM todas as tarefas que ainda não estão lá">⤴ Associar todas ao ITSM</button>
            <button type="button" className="primary" disabled={syncing} onClick={() => run('POST', `/projects/${p.id}/glpi/sync`)}
              title="Envia as alterações daqui e traz as feitas no ITSM, para todas as tarefas associadas">{syncing ? 'Aguarde…' : '⟳ Sincronizar com ITSM'}</button>
            <button type="button" className="pm-danger" onClick={removeProject} title="Excluir projeto">🗑</button>
          </div>
        </div>
        <div className="kpis pm-kpis">
          <div className="kpi tone-blue">
            <span className="kpi-label">Planejado × realizado (hoje)</span>
            <ProgressPair progress={s.progress} expected={s.expected} />
            <span className="kpi-sub">{gap === null ? 'sem datas planejadas' : gap >= -0.5 ? `adiantado/em dia (${gap >= 0 ? '+' : ''}${Math.round(gap)} p.p.)` : `atrasado ${Math.round(-gap)} p.p.`}</span>
          </div>
          <div className="kpi tone-green"><span className="kpi-value">{s.done}/{s.tasks}</span><span className="kpi-label">Tarefas concluídas</span><span className="kpi-sub">{s.inProgress} em andamento</span></div>
          <div className={`kpi tone-${s.late ? 'red' : 'gray'}`}><span className="kpi-value">{s.late}</span><span className="kpi-label">Tarefas atrasadas</span><span className="kpi-sub">fim planejado vencido</span></div>
          <div className={`kpi tone-${slip > 0 ? 'red' : 'green'}`}>
            <span className="kpi-value">{fmt(s.forecast)}</span><span className="kpi-label">Término previsto</span>
            <span className="kpi-sub">{s.forecast ? (slip > 0 ? `${slip} dia(s) depois do fim do projeto` : 'dentro do prazo do projeto') : 'sem datas'}</span>
          </div>
          <div className="kpi tone-amber"><span className="kpi-value">{s.milestonesDone}/{s.milestones}</span><span className="kpi-label">Marcos atingidos</span><span className="kpi-sub">realizado do projeto {pct(s.progress)}</span></div>
        </div>
      </section>

      {error && <div className="banner error" role="alert">{error} <button className="link" onClick={() => setError(null)}>fechar</button></div>}
      {notice.length > 0 && <div className="banner info pm-notice" role="status">{notice.map((m, i) => <div key={i}>{m}</div>)}</div>}

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'tarefas'} className={tab === 'tarefas' ? 'on' : ''} onClick={() => go(p.id, 'tarefas')}>Tarefas</button>
        <button role="tab" aria-selected={tab === 'gantt'} className={tab === 'gantt' ? 'on' : ''} onClick={() => go(p.id, 'gantt')}>Gráfico de Gantt</button>
      </nav>

      {tab === 'tarefas' && (
        <>
          <Milestones ctx={ctx} />
          <TaskGrid ctx={ctx} onOpen={(tid, section) => setDrawer({ id: tid, section })} selectedId={drawer?.id ?? null} />
        </>
      )}
      {tab === 'gantt' && <Gantt view={view} meta={meta} entityName={shortEntity(meta.entities.find(e => e.id === p.entityId)?.name ?? p.entityName)} onOpen={tid => setDrawer({ id: tid })} />}

      {drawer && view.tasks.some(t => t.id === drawer.id) && (
        <TaskDrawer key={drawer.id} ctx={ctx} taskId={drawer.id} section={drawer.section} onClose={() => setDrawer(null)} onOpen={tid => setDrawer({ id: tid })} />
      )}
      {editing && (
        <ProjectForm meta={meta} initial={p} defaultEntity={p.entityId} onClose={() => setEditing(false)}
          onSave={async v => { apply(await pm<PmProjectView>('PUT', `/projects/${p.id}`, v)); setEditing(false) }} />
      )}
    </>
  )
}

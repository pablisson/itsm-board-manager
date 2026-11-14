import { useEffect, useRef, useState } from 'react'
import type { PmCtx } from './ProjectView'
import type { PmMilestone } from './types'
import { fmt, MILESTONE_STATE } from './util'

interface Form { id: number | null; name: string; objective: string; dueDate: string; taskIds: Set<number> }

export default function Milestones({ ctx }: { ctx: PmCtx }) {
  const { view, run } = ctx
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('pm.milestones.open') !== '0' } catch { return true } })
  const [form, setForm] = useState<Form | null>(null)
  useEffect(() => { try { localStorage.setItem('pm.milestones.open', open ? '1' : '0') } catch { /* sem storage */ } }, [open])
  const byId = new Map(view.tasks.map(t => [t.id, t]))
  const ms = view.milestones

  const edit = (m?: PmMilestone) => setForm(m
    ? { id: m.id, name: m.name, objective: m.objective ?? '', dueDate: m.dueDate, taskIds: new Set(m.taskIds) }
    : { id: null, name: '', objective: '', dueDate: view.project.endDate, taskIds: new Set() })

  return (
    <section className="panel pm-ms">
      <header className="pm-ms-head">
        <button type="button" className="pm-twisty" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
        <h2>Marcos <span className="pm-muted">({ms.filter(m => m.state.startsWith('done')).length}/{ms.length} atingidos)</span></h2>
        <button type="button" className="link" onClick={() => edit()}>+ Novo marco</button>
      </header>
      {open && (
        ms.length === 0
          ? <p className="empty">Nenhum marco. Marcos são pontos de controle com data e objetivo, ligados às tarefas que precisam estar prontas.</p>
          : (
            <div className="pm-ms-list">
              {ms.map(m => {
                const s = MILESTONE_STATE[m.state]!
                return (
                  <button type="button" key={m.id} className={`pm-ms-card tone-${s.tone}`} onClick={() => edit(m)} title="Editar marco">
                    <span className="pm-ms-top"><span className="pm-diamond" aria-hidden>◆</span><b>{m.name}</b><span className={`pm-tag tone-${s.tone}`}>{s.label}</span></span>
                    {m.objective && <span className="pm-ms-obj">🎯 {m.objective}</span>}
                    <span className="pm-ms-meta">
                      Meta {fmt(m.dueDate)}
                      {m.doneDate ? <> · atingido {fmt(m.doneDate)}</> : m.forecast && <> · previsão {fmt(m.forecast)}</>}
                      {' · '}{Math.round(m.progress)}% · {m.taskIds.length} tarefa(s)
                    </span>
                    <span className="pm-ms-bar"><span style={{ width: `${m.progress}%` }} /></span>
                  </button>
                )
              })}
            </div>
          )
      )}
      {form && <MilestoneForm form={form} tasks={view.tasks.map(t => ({ id: t.id, label: `${t.wbs} ${t.title}`, level: t.level, done: t.done }))}
        byId={byId} onClose={() => setForm(null)}
        onSave={async f => {
          const body = { name: f.name, objective: f.objective, dueDate: f.dueDate, taskIds: [...f.taskIds] }
          const ok = await run(f.id ? 'PUT' : 'POST', f.id ? `/milestones/${f.id}` : `/projects/${view.project.id}/milestones`, body)
          if (ok) setForm(null)
        }}
        onDelete={form.id ? async () => { if (confirm('Excluir este marco?') && await run('DELETE', `/milestones/${form.id}`)) setForm(null) } : undefined} />}
    </section>
  )
}

function MilestoneForm({ form, tasks, onSave, onClose, onDelete }: {
  form: Form; tasks: { id: number; label: string; level: number; done: boolean }[]; byId: Map<number, unknown>
  onSave: (f: Form) => Promise<void>; onClose: () => void; onDelete?: () => void
}) {
  const [f, setF] = useState(form)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  const list = tasks.filter(t => !q.trim() || t.label.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <dialog ref={ref} className="pm-dialog" onClose={onClose} aria-labelledby="ms-title">
      <form onSubmit={e => { e.preventDefault(); void onSave(f) }}>
        <h2 id="ms-title">{f.id ? 'Editar marco' : 'Novo marco'}</h2>
        <label>Nome<input required maxLength={200} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus /></label>
        <label>Objetivo<textarea rows={3} maxLength={5000} value={f.objective} onChange={e => setF({ ...f, objective: e.target.value })} placeholder="O que precisa estar entregue/garantido neste marco" /></label>
        <label>Data meta<input type="date" required value={f.dueDate} onChange={e => setF({ ...f, dueDate: e.target.value })} /></label>
        <fieldset className="pm-ms-tasks">
          <legend>Tarefas do marco ({f.taskIds.size})</legend>
          <input type="search" placeholder="Filtrar tarefas…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="pm-pop-list">
            {list.map(t => (
              <label key={t.id} className="pm-check" style={{ paddingLeft: 6 + t.level * 16 }}>
                <input type="checkbox" checked={f.taskIds.has(t.id)} onChange={e => { const s = new Set(f.taskIds); if (e.target.checked) s.add(t.id); else s.delete(t.id); setF({ ...f, taskIds: s }) }} />
                <span className={t.done ? 'pm-strike' : ''}>{t.label}</span>
              </label>
            ))}
            {tasks.length === 0 && <p className="empty">O projeto ainda não tem tarefas.</p>}
          </div>
        </fieldset>
        <div className="pm-dialog-actions">
          {onDelete && <button type="button" className="pm-danger" onClick={onDelete}>Excluir marco</button>}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => ref.current?.close()}>Cancelar</button>
          <button type="submit" className="primary">Salvar</button>
        </div>
      </form>
    </dialog>
  )
}

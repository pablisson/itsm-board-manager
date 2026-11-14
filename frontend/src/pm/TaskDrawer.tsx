import { useEffect, useMemo, useRef, useState } from 'react'
import { attachmentUrl, pmUpload } from './api'
import AssigneePicker, { PersonChips } from './AssigneePicker'
import ProgressPair from './ProgressPair'
import type { PmCtx } from './ProjectView'
import type { PmProjectView } from './types'
import { DEP_TYPES, fileSize, fmt, fmtLong, MILESTONE_STATE } from './util'

export default function TaskDrawer({ ctx, taskId, section, onClose, onOpen }: {
  ctx: PmCtx; taskId: number; section?: string; onClose: () => void; onOpen: (id: number) => void
}) {
  const { view, meta, run, busy, apply } = ctx
  const t = view.tasks.find(x => x.id === taskId)!
  const byId = useMemo(() => new Map(view.tasks.map(x => [x.id, x])), [view.tasks])
  const root = useRef<HTMLElement>(null)
  const [newItem, setNewItem] = useState('')
  const [dep, setDep] = useState({ predId: 0, type: 0, lagDays: 0 })
  const [upErr, setUpErr] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    const el = section ? root.current?.querySelector<HTMLElement>(`[data-section="${section}"]`) : null
    el?.scrollIntoView({ block: 'start' })
    el?.querySelector<HTMLElement>('textarea, input:not([type=checkbox]), select')?.focus()
  }, [section])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.pm-pop')) onClose() }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  }, [onClose])

  const patch = (body: Record<string, unknown>) => run('PATCH', `/tasks/${t.id}`, body)
  const st = meta.states.find(s => s.id === t.statusId)
  const preds = view.dependencies.filter(d => d.succId === t.id)
  const succs = view.dependencies.filter(d => d.predId === t.id)
  const isRelative = (a: number, b: number) => {
    for (let p = byId.get(a)?.parentId; p; p = byId.get(p)?.parentId ?? null) if (p === b) return true
    return false
  }
  const candidates = view.tasks.filter(x => x.id !== t.id && !isRelative(x.id, t.id) && !isRelative(t.id, x.id) && !preds.some(d => d.predId === x.id))
  const milestones = view.milestones.filter(m => m.taskIds.includes(t.id))
  const ckOpen = t.checklist.filter(c => !c.done).length

  const upload = async (files: FileList | File[]) => {
    if (!files.length) return
    setUploading(true); setUpErr(null)
    try { apply(await pmUpload<PmProjectView>(`/tasks/${t.id}/attachments`, files)) } catch (e) { setUpErr(e instanceof Error ? e.message : String(e)) } finally { setUploading(false) }
  }

  return (
    <aside className="pm-drawer" ref={root} role="dialog" aria-label={`Tarefa ${t.wbs}`}>
      <header className="pm-drawer-head">
        <div>
          <span className="pm-muted">Tarefa {t.wbs}{t.parentId && <> · em <button type="button" className="link" onClick={() => onOpen(t.parentId!)}>{byId.get(t.parentId)?.wbs} {byId.get(t.parentId)?.title}</button></>}</span>
          <input className={`pm-drawer-title${t.isSummary ? ' pm-xb' : ''}`} key={t.title} defaultValue={t.title} maxLength={300} aria-label="Título"
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.title) void patch({ title: v }); else e.target.value = t.title }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        </div>
        <button type="button" className="pm-x" onClick={onClose} aria-label="Fechar">×</button>
      </header>

      <div className="pm-drawer-body">
        <section className="pm-sec" data-section="main">
          <div className="pm-kv">
            <span>Status</span>
            {t.isSummary
              ? <span className="pm-status"><i style={{ background: st?.color ?? undefined }} />{st?.label} <span className="pm-muted">(calculado)</span></span>
              : <select value={t.statusId} onChange={e => patch({ statusId: Number(e.target.value) })}>{meta.states.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>}
            <span>Responsáveis</span>
            <AssigneePicker users={meta.users} selected={t.assignees} onSave={people => patch({ assignees: people })}>
              <PersonChips people={t.assignees} max={6} /> <span className="pm-muted">✎</span>
            </AssigneePicker>
            <span>Realizado</span>
            <span className="pm-prog-edit">
              <ProgressPair progress={t.progress} expected={t.expected} />
              {!t.isSummary && !t.done && t.checklist.length === 0 && (
                <input type="range" min={0} max={100} step={5} key={t.percent} defaultValue={t.percent} aria-label="% realizado"
                  onMouseUp={e => patch({ percent: Number(e.currentTarget.value) })} onKeyUp={e => patch({ percent: Number(e.currentTarget.value) })} />
              )}
              {t.checklist.length > 0 && !t.done && <span className="pm-muted">calculado pelo checklist</span>}
            </span>
          </div>
          <table className="pm-dates">
            <thead><tr><th /><th>Planejado</th><th>Executado</th></tr></thead>
            <tbody>
              {(['Start', 'End'] as const).map(k => (
                <tr key={k}>
                  <th>{k === 'Start' ? 'Início' : 'Fim'}</th>
                  {(['plan', 'real'] as const).map(kind => {
                    const field = `${kind}${k}` as 'planStart' | 'planEnd' | 'realStart' | 'realEnd'
                    return (
                      <td key={kind}>
                        {t.isSummary ? fmtLong(t[field]) : (
                          <input type="date" key={t[field] ?? ''} defaultValue={t[field] ?? ''} max={kind === 'real' ? view.today : undefined}
                            onBlur={e => { const v = e.target.value || null; if (v !== t[field]) void patch({ [field]: v }) }} aria-label={`${k === 'Start' ? 'Início' : 'Fim'} ${kind === 'plan' ? 'planejado' : 'executado'}`} />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {t.isSummary && <p className="pm-muted">Tarefa-resumo: datas, status e % vêm das subtarefas.</p>}
          {t.endVarDays !== null && <p className={t.endVarDays > 0 ? 'pm-bad' : 'pm-good'}>{t.done ? (t.endVarDays > 0 ? `Concluída ${t.endVarDays} dia(s) depois do planejado.` : t.endVarDays < 0 ? `Concluída ${-t.endVarDays} dia(s) antes do planejado.` : 'Concluída no dia planejado.') : `Atrasada: fim planejado venceu há ${t.endVarDays} dia(s).`}</p>}
        </section>

        <section className="pm-sec" data-section="desc">
          <h3>Descrição</h3>
          <textarea rows={5} key={t.description ?? ''} defaultValue={t.description ?? ''} maxLength={20000} placeholder="Detalhes da tarefa…"
            onBlur={e => { const v = e.target.value.trim(); if (v !== (t.description ?? '')) void patch({ description: v }) }} />
        </section>

        <section className="pm-sec" data-section="deps">
          <h3>Depende de</h3>
          {preds.length === 0 && <p className="pm-muted">Nenhuma dependência.</p>}
          {preds.map(d => {
            const p = byId.get(d.predId)!
            return (
              <div key={d.id} className={`pm-deprow${d.violated ? ' bad' : ''}`}>
                <button type="button" className="link" onClick={() => onOpen(p.id)}>{p.wbs} {p.title}</button>
                <select value={d.type} onChange={e => run('PUT', `/dependencies/${d.id}`, { predId: d.predId, succId: d.succId, type: Number(e.target.value), lagDays: d.lagDays })} aria-label="Tipo">
                  {DEP_TYPES.map(x => <option key={x.id} value={x.id} title={x.help}>{x.code} · {x.label}</option>)}
                </select>
                <label className="pm-lag" title="Folga em dias (negativo = antecipa)">±<input type="number" key={d.lagDays} defaultValue={d.lagDays} min={-365} max={365}
                  onBlur={e => { const v = Number(e.target.value) || 0; if (v !== d.lagDays) void run('PUT', `/dependencies/${d.id}`, { predId: d.predId, succId: d.succId, type: d.type, lagDays: v }) }} />d</label>
                <button type="button" className="pm-x sm" onClick={() => run('DELETE', `/dependencies/${d.id}`)} aria-label="Remover dependência">×</button>
                {d.violated && <span className="pm-bad pm-deprow-msg">⚠ As datas planejadas não respeitam esta dependência. <button type="button" className="link" onClick={() => run('POST', `/tasks/${t.id}/align`)}>Ajustar datas</button></span>}
              </div>
            )
          })}
          <form className="pm-depadd" onSubmit={e => { e.preventDefault(); if (dep.predId) void run('POST', `/projects/${view.project.id}/dependencies`, { predId: dep.predId, succId: t.id, type: dep.type, lagDays: dep.lagDays }).then(() => setDep({ predId: 0, type: 0, lagDays: 0 })) }}>
            <select value={dep.predId} onChange={e => setDep(d => ({ ...d, predId: Number(e.target.value) }))} aria-label="Tarefa predecessora">
              <option value={0}>+ Adicionar predecessora…</option>
              {candidates.map(x => <option key={x.id} value={x.id}>{x.wbs} {x.title}</option>)}
            </select>
            <select value={dep.type} onChange={e => setDep(d => ({ ...d, type: Number(e.target.value) }))} aria-label="Tipo de dependência">
              {DEP_TYPES.map(x => <option key={x.id} value={x.id}>{x.code} · {x.label}</option>)}
            </select>
            <label className="pm-lag" title="Folga em dias (negativo = antecipa)">±<input type="number" value={dep.lagDays} min={-365} max={365} onChange={e => setDep(d => ({ ...d, lagDays: Number(e.target.value) || 0 }))} />d</label>
            <button type="submit" className="primary sm" disabled={!dep.predId || busy}>Adicionar</button>
          </form>
          <p className="pm-muted pm-help">{DEP_TYPES[dep.type]!.help} Folga negativa permite começar antes (ex.: TI −2d = começa 2 dias antes do término).</p>
          {succs.length > 0 && <p className="pm-muted">Esta tarefa é predecessora de: {succs.map(d => byId.get(d.succId)?.wbs).join(', ')}</p>}
        </section>

        <section className="pm-sec" data-section="checklist">
          <h3>Checklist {t.checklist.length > 0 && <span className="pm-muted">({t.checklist.length - ckOpen}/{t.checklist.length})</span>}</h3>
          {ckOpen > 0 && !t.done && <p className="pm-muted">A tarefa só pode ser concluída com todos os itens marcados.</p>}
          <ul className="pm-checklist">
            {t.checklist.map(c => (
              <li key={c.id}>
                <label className="pm-check"><input type="checkbox" checked={c.done} onChange={e => run('PUT', `/checklist/${c.id}`, { done: e.target.checked })} /><span className={c.done ? 'pm-strike' : ''}>{c.text}</span></label>
                <button type="button" className="pm-x sm" onClick={() => run('DELETE', `/checklist/${c.id}`)} aria-label={`Remover ${c.text}`}>×</button>
              </li>
            ))}
          </ul>
          <form className="pm-inline" onSubmit={e => { e.preventDefault(); if (newItem.trim()) void run('POST', `/tasks/${t.id}/checklist`, { text: newItem }).then(() => setNewItem('')) }}>
            <input value={newItem} onChange={e => setNewItem(e.target.value)} placeholder="Novo item do checklist…" maxLength={500} aria-label="Novo item do checklist" />
            <button type="submit" className="primary sm" disabled={!newItem.trim()}>Adicionar</button>
          </form>
        </section>

        <section className="pm-sec" data-section="files">
          <h3>Anexos</h3>
          <ul className="pm-files">
            {t.attachments.map(a => (
              <li key={a.id}>
                <a href={attachmentUrl(a.id)} download={a.fileName}>📄 {a.fileName}</a>
                <span className="pm-muted">{fileSize(a.size)} · {fmt(a.createdAt.slice(0, 10))}</span>
                <button type="button" className="pm-x sm" onClick={() => { if (confirm(`Excluir o anexo “${a.fileName}”?`)) void run('DELETE', `/attachments/${a.id}`) }} aria-label={`Excluir ${a.fileName}`}>×</button>
              </li>
            ))}
          </ul>
          <label className={`pm-drop${dragOver ? ' over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); void upload(e.dataTransfer.files) }}>
            <input type="file" multiple onChange={e => { void upload(e.target.files ?? []); e.target.value = '' }} />
            {uploading ? 'Enviando…' : 'Arraste arquivos aqui ou clique para escolher (até 20 MB cada)'}
          </label>
          {upErr && <div className="banner error">{upErr}</div>}
        </section>

        {milestones.length > 0 && (
          <section className="pm-sec">
            <h3>Marcos</h3>
            {milestones.map(m => <p key={m.id}>◆ {m.name} · {fmt(m.dueDate)} · <span className={`pm-tag tone-${MILESTONE_STATE[m.state]?.tone}`}>{MILESTONE_STATE[m.state]?.label}</span></p>)}
          </section>
        )}

        <section className="pm-sec" data-section="itsm">
          <h3>ITSM</h3>
          {t.glpiTaskId ? (
            <>
              <p>Tarefa de projeto <b>#{t.glpiTaskId}</b>{meta.itsmUrl && <> · <a href={`${meta.itsmUrl}/front/projecttask.form.php?id=${t.glpiTaskId}`} target="_blank" rel="noreferrer">abrir no ITSM ↗</a></>}</p>
              <p className="pm-muted">Última sincronização: {t.glpiSyncedAt ? new Date(t.glpiSyncedAt).toLocaleString('pt-BR') : '—'}{t.glpiPending && <b className="pm-pending"> · há alterações não enviadas</b>}</p>
              <button type="button" className="primary sm" disabled={busy} onClick={() => run('POST', `/tasks/${t.id}/glpi/sync`)}>⟳ Sincronizar</button>
            </>
          ) : (
            <>
              <p className="pm-muted">Ainda não está no ITSM. Ao associar, a tarefa é criada como tarefa de projeto (com o projeto e as tarefas-pai, se ainda não existirem lá).</p>
              <button type="button" className="primary sm" disabled={busy} onClick={() => run('POST', `/tasks/${t.id}/glpi/link`)}>⤴ Associar ao ITSM</button>
            </>
          )}
        </section>
      </div>
    </aside>
  )
}

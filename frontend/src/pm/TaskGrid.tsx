import { useEffect, useMemo, useRef, useState } from 'react'
import AssigneePicker, { PersonChips } from './AssigneePicker'
import ProgressPair from './ProgressPair'
import type { PmCtx } from './ProjectView'
import type { PmTask } from './types'
import { depCode, fmt } from './util'

const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && +v.slice(0, 4) >= 2000 && +v.slice(0, 4) <= 2100

/** Campo de data que só grava quando a data está completa (digitação do ano não dispara gravações parciais). */
function DateCell({ value, onSave, disabled, min, max, className, label }: {
  value: string | null; onSave: (v: string | null) => void; disabled?: boolean; min?: string; max?: string; className?: string; label: string
}) {
  const commit = (v: string) => { if (v === (value ?? '')) return; if (v === '' || validDate(v)) onSave(v || null) }
  return (
    <input type="date" key={value ?? ''} defaultValue={value ?? ''} disabled={disabled} min={min} max={max} aria-label={label} className={`pm-date ${className ?? ''}`}
      onChange={e => { if (validDate(e.target.value)) commit(e.target.value) }} onBlur={e => commit(e.target.value)} />
  )
}

export default function TaskGrid({ ctx, onOpen, selectedId }: { ctx: PmCtx; onOpen: (id: number, section?: string) => void; selectedId: number | null }) {
  const { view, meta, run, busy } = ctx
  const pid = view.project.id
  const [focusId, setFocusId] = useState<number | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const storeKey = `pm.collapsed.${pid}`
  const [collapsed, setCollapsed] = useState<Set<number>>(() => { try { return new Set(JSON.parse(localStorage.getItem(storeKey) ?? '[]') as number[]) } catch { return new Set() } })
  useEffect(() => { try { localStorage.setItem(storeKey, JSON.stringify([...collapsed])) } catch { /* sem storage */ } }, [collapsed, storeKey])
  const tableRef = useRef<HTMLTableElement>(null)

  const byId = useMemo(() => new Map(view.tasks.map(t => [t.id, t])), [view.tasks])
  const predsOf = useMemo(() => {
    const m = new Map<number, typeof view.dependencies>()
    for (const d of view.dependencies) { if (!m.has(d.succId)) m.set(d.succId, []); m.get(d.succId)!.push(d) }
    return m
  }, [view.dependencies])
  const stateById = useMemo(() => new Map(meta.states.map(s => [s.id, s])), [meta.states])
  const finished = meta.states.filter(s => s.isFinished).map(s => s.id)

  // visíveis: respeita recolhidos; com busca, mostra os que batem + os pais
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase()
    const hit = (t: PmTask) => `${t.wbs} ${t.title} ${t.description ?? ''} ${t.assignees.map(a => a.name).join(' ')} ${t.glpiTaskId ?? ''}`.toLowerCase().includes(term)
    const keep = new Set<number>()
    for (const t of view.tasks) {
      if ((term && !hit(t)) || (hideDone && t.done)) continue
      keep.add(t.id)
      for (let p = t.parentId; p; p = byId.get(p)?.parentId ?? null) keep.add(p)
    }
    return view.tasks.filter(t => {
      if (!keep.has(t.id)) return false
      if (term) return true
      for (let p = t.parentId; p; p = byId.get(p)?.parentId ?? null) if (collapsed.has(p)) return false
      return true
    })
  }, [view.tasks, q, hideDone, collapsed, byId])

  useEffect(() => {
    if (focusId === null) return
    const el = tableRef.current?.querySelector<HTMLInputElement>(`[data-title="${focusId}"]`)
    if (el) { el.focus(); el.select(); setFocusId(null) }
  }, [view, focusId])

  useEffect(() => {
    if (menu === null) return
    const f = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.pm-rowmenu')) setMenu(null) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', f); document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', f); document.removeEventListener('keydown', k) }
  }, [menu])

  const patch = (id: number, body: Record<string, unknown>) => run('PATCH', `/tasks/${id}`, body)
  const addTask = async (afterId?: number) => {
    const r = await run<{ taskId: number }>('POST', `/projects/${pid}/tasks`, { title: 'Nova tarefa', afterId })
    if (r?.taskId) setFocusId(r.taskId)
  }
  const saveTitle = async (t: PmTask, el: HTMLInputElement) => {
    const v = el.value.trim()
    if (!v) { el.value = t.title; return }
    if (v !== t.title) await patch(t.id, { title: v })
  }
  const moveFocus = (from: number, dir: 1 | -1) => {
    const i = visible.findIndex(t => t.id === from)
    const next = visible[i + dir]
    if (next) tableRef.current?.querySelector<HTMLInputElement>(`[data-title="${next.id}"]`)?.focus()
  }

  const onTitleKey = async (e: React.KeyboardEvent<HTMLInputElement>, t: PmTask) => {
    const el = e.currentTarget
    if (e.key === 'Tab') {
      e.preventDefault()
      await saveTitle(t, el)
      await run('POST', `/tasks/${t.id}/${e.shiftKey ? 'outdent' : 'indent'}`)
      setFocusId(t.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      await saveTitle(t, el)
      await addTask(t.id)
    } else if (e.key === 'Escape') {
      el.value = t.title; el.blur()
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      e.preventDefault()
      await saveTitle(t, el)
      await run('POST', `/tasks/${t.id}/move/${e.key === 'ArrowUp' ? 'up' : 'down'}`)
      setFocusId(t.id)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      moveFocus(t.id, e.key === 'ArrowUp' ? -1 : 1)
    }
  }

  const remove = async (t: PmTask) => {
    const subs = view.tasks.filter(x => x.wbs.startsWith(t.wbs + '.')).length
    const linked = t.glpiTaskId ? `\n\nA tarefa #${t.glpiTaskId} no ITSM NÃO é apagada.` : ''
    if (!confirm(`Excluir a tarefa ${t.wbs} “${t.title}”${subs ? ` e ${subs} subtarefa(s)` : ''}?${linked}`)) return
    await run('DELETE', `/tasks/${t.id}`)
  }

  const toggle = (id: number) => setCollapsed(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const itsmLink = (id: number) => meta.itsmUrl ? `${meta.itsmUrl}/front/projecttask.form.php?id=${id}` : undefined

  return (
    <section className="panel pm-tasks">
      <header className="panel-head row">
        <div>
          <h2>Tarefas</h2>
          <p>
            <kbd>Enter</kbd> nova tarefa abaixo · <kbd>Tab</kbd> vira subtarefa da de cima · <kbd>Shift</kbd>+<kbd>Tab</kbd> volta um nível ·
            {' '}<kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> move · <kbd>↑</kbd>/<kbd>↓</kbd> navega. Até 3 níveis; tarefa com subtarefas fica em <b className="pm-xb">negrito extra</b> e tem datas calculadas.
          </p>
        </div>
        <div className="actions">
          <input type="search" placeholder="Filtrar tarefas…" value={q} onChange={e => setQ(e.target.value)} />
          <label className="pm-toggle"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} /> Ocultar concluídas</label>
          <button type="button" onClick={() => setCollapsed(new Set())} disabled={!collapsed.size}>Expandir tudo</button>
          <button type="button" onClick={() => setCollapsed(new Set(view.tasks.filter(t => t.isSummary).map(t => t.id)))}>Recolher tudo</button>
        </div>
      </header>

      <div className="pm-grid-wrap">
        <table className="pm-grid" ref={tableRef}>
          <thead>
            <tr>
              <th className="c-num">Nº</th>
              <th className="c-title">Tarefa</th>
              <th className="c-desc">Descrição</th>
              <th className="c-status">Status</th>
              <th className="c-people">Responsáveis</th>
              <th className="c-date">Início planejado</th>
              <th className="c-date">Início executado</th>
              <th className="c-date">Fim planejado</th>
              <th className="c-date">Fim executado (conclusão)</th>
              <th className="c-dep">Depende de</th>
              <th className="c-prog" title="Realizado / previsto para hoje pelo planejado">Realizado / previsto</th>
              <th className="c-var" title="Diferença entre o fim executado (ou hoje, se atrasada) e o fim planejado">Desvio</th>
              <th className="c-ico" title="Checklist">✓</th>
              <th className="c-ico" title="Anexos">📎</th>
              <th className="c-itsm">ID ITSM</th>
              <th className="c-act">Ações</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(t => {
              const st = stateById.get(t.statusId)
              const preds = predsOf.get(t.id) ?? []
              const ck = t.checklist, ckDone = ck.filter(c => c.done).length
              const isCollapsed = collapsed.has(t.id)
              return (
                <tr key={t.id} className={`lvl-${t.level}${t.isSummary ? ' summary' : ''}${t.done ? ' done' : ''}${t.late ? ' late' : ''}${selectedId === t.id ? ' selected' : ''}`}>
                  <td className="c-num">{t.wbs}</td>
                  <td className="c-title">
                    <div className="pm-title-cell" style={{ paddingLeft: t.level * 20 }}>
                      {t.isSummary
                        ? <button type="button" className="pm-twisty" onClick={() => toggle(t.id)} aria-label={isCollapsed ? 'Expandir' : 'Recolher'} aria-expanded={!isCollapsed}>{isCollapsed ? '▸' : '▾'}</button>
                        : <span className="pm-twisty-sp">{t.done ? <span className="pm-ok" title="Concluída">✓</span> : ''}</span>}
                      <input className="pm-title" data-title={t.id} key={`${t.id}:${t.title}`} defaultValue={t.title} maxLength={300}
                        aria-label={`Título da tarefa ${t.wbs}`} onKeyDown={e => onTitleKey(e, t)} onBlur={e => saveTitle(t, e.currentTarget)} />
                      {t.outOfProject && <span className="pm-warn" title="Datas fora do período do projeto">⚠</span>}
                    </div>
                  </td>
                  <td className="c-desc">
                    <button type="button" className="pm-cellbtn pm-desc-btn" onClick={() => onOpen(t.id, 'desc')} title={t.description ?? 'Adicionar descrição'}>
                      {t.description ? t.description.split('\n')[0] : <span className="pm-muted">+ descrição</span>}
                    </button>
                  </td>
                  <td className="c-status">
                    {t.isSummary
                      ? <span className="pm-status" title="Calculado a partir das subtarefas"><i style={{ background: st?.color ?? undefined }} />{st?.label ?? t.statusId}</span>
                      : (
                        <label className="pm-status">
                          <i style={{ background: st?.color ?? undefined }} />
                          <select value={t.statusId} onChange={e => patch(t.id, { statusId: Number(e.target.value) })} aria-label="Status">
                            {meta.states.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                        </label>
                      )}
                  </td>
                  <td className="c-people">
                    <AssigneePicker users={meta.users} selected={t.assignees} onSave={people => patch(t.id, { assignees: people })}>
                      <PersonChips people={t.assignees} />
                    </AssigneePicker>
                  </td>
                  {t.isSummary ? (
                    <>
                      <td className="c-date calc" title="Calculado das subtarefas">{fmt(t.planStart)}</td>
                      <td className="c-date calc" title="Calculado das subtarefas">{fmt(t.realStart)}</td>
                      <td className={`c-date calc${t.late ? ' pm-bad' : ''}`} title="Calculado das subtarefas">{fmt(t.planEnd)}</td>
                      <td className="c-date calc" title="Calculado das subtarefas">{fmt(t.realEnd)}</td>
                    </>
                  ) : (
                    <>
                      <td className="c-date"><DateCell label="Início planejado" value={t.planStart} max={t.planEnd ?? undefined} onSave={v => patch(t.id, { planStart: v })} /></td>
                      <td className="c-date"><DateCell label="Início executado" value={t.realStart} max={t.realEnd ?? view.today} onSave={v => patch(t.id, { realStart: v })} /></td>
                      <td className="c-date"><DateCell label="Fim planejado" value={t.planEnd} min={t.planStart ?? undefined} className={t.late ? 'pm-bad' : ''} onSave={v => patch(t.id, { planEnd: v })} /></td>
                      <td className="c-date"><DateCell label="Fim executado" value={t.realEnd} min={t.realStart ?? undefined} max={view.today} className={t.done ? 'pm-good' : ''} onSave={v => patch(t.id, { realEnd: v })} /></td>
                    </>
                  )}
                  <td className="c-dep">
                    <button type="button" className="pm-cellbtn" onClick={() => onOpen(t.id, 'deps')} title="Editar dependências">
                      {preds.length ? preds.map(d => (
                        <span key={d.id} className={`pm-dep${d.violated ? ' bad' : ''}`} title={d.violated ? 'Datas não respeitam esta dependência' : undefined}>
                          {byId.get(d.predId)?.wbs}{depCode(d.type, d.lagDays)}{d.violated ? ' ⚠' : ''}
                        </span>
                      )) : <span className="pm-muted">+</span>}
                    </button>
                  </td>
                  <td className="c-prog"><ProgressPair progress={t.progress} expected={t.expected} compact /></td>
                  <td className={`c-var ${t.endVarDays === null ? '' : t.endVarDays > 0 ? 'pm-bad' : 'pm-good'}`}
                    title={t.endVarDays === null ? '' : t.done ? 'Conclusão − fim planejado' : 'Atraso até hoje'}>
                    {t.endVarDays === null ? '—' : t.endVarDays > 0 ? `+${t.endVarDays}d` : `${t.endVarDays}d`}
                  </td>
                  <td className="c-ico">
                    <button type="button" className={`pm-cellbtn${ck.length && ckDone === ck.length ? ' pm-good' : ''}`} onClick={() => onOpen(t.id, 'checklist')} title="Checklist">
                      {ck.length ? `${ckDone}/${ck.length}` : <span className="pm-muted">+</span>}
                    </button>
                  </td>
                  <td className="c-ico">
                    <button type="button" className="pm-cellbtn" onClick={() => onOpen(t.id, 'files')} title="Anexos">
                      {t.attachments.length || <span className="pm-muted">+</span>}
                    </button>
                  </td>
                  <td className="c-itsm">
                    {t.glpiTaskId
                      ? <a href={itsmLink(t.glpiTaskId)} target="_blank" rel="noreferrer" title={t.glpiPending ? 'Alterada aqui depois da última sincronização' : 'Sincronizada'}>#{t.glpiTaskId}{t.glpiPending && <span className="pm-pending" aria-label="pendente de sincronização"> ●</span>}</a>
                      : <span className="pm-muted">—</span>}
                  </td>
                  <td className="c-act">
                    {t.glpiTaskId
                      ? <button type="button" className="pm-mini" disabled={busy} onClick={() => run('POST', `/tasks/${t.id}/glpi/sync`)} title="Sincronizar com o ITSM">⟳</button>
                      : <button type="button" className="pm-mini" disabled={busy} onClick={() => run('POST', `/tasks/${t.id}/glpi/link`)} title="Associar ao ITSM (cria a tarefa no ITSM)">⤴ ITSM</button>}
                    <button type="button" className="pm-mini" onClick={() => onOpen(t.id)} title="Detalhes">☰</button>
                    <span className="pm-rowmenu">
                      <button type="button" className="pm-mini" aria-haspopup="menu" aria-expanded={menu === t.id} onClick={() => setMenu(menu === t.id ? null : t.id)} title="Mais ações">⋯</button>
                      {menu === t.id && (
                        <span className="pm-menu" role="menu">
                          <button role="menuitem" onClick={() => { setMenu(null); void addTask(t.id) }}>+ Nova tarefa abaixo</button>
                          <button role="menuitem" onClick={() => { setMenu(null); void run('POST', `/tasks/${t.id}/indent`) }}>→ Virar subtarefa (Tab)</button>
                          <button role="menuitem" onClick={() => { setMenu(null); void run('POST', `/tasks/${t.id}/outdent`) }}>← Subir nível (Shift+Tab)</button>
                          <button role="menuitem" onClick={() => { setMenu(null); void run('POST', `/tasks/${t.id}/move/up`) }}>↑ Mover para cima</button>
                          <button role="menuitem" onClick={() => { setMenu(null); void run('POST', `/tasks/${t.id}/move/down`) }}>↓ Mover para baixo</button>
                          {preds.length > 0 && <button role="menuitem" onClick={() => { setMenu(null); void run('POST', `/tasks/${t.id}/align`) }}>⇥ Ajustar datas pelas dependências</button>}
                          {!t.isSummary && !t.done && <button role="menuitem" onClick={() => { setMenu(null); void patch(t.id, { statusId: finished[0] }) }}>✓ Concluir hoje</button>}
                          <button role="menuitem" className="danger" onClick={() => { setMenu(null); void remove(t) }}>🗑 Excluir</button>
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
            {visible.length === 0 && view.tasks.length > 0 && <tr><td colSpan={16} className="empty">Nenhuma tarefa com esse filtro.</td></tr>}
          </tbody>
        </table>
      </div>
      <button type="button" className="pm-add" onClick={() => addTask()} disabled={busy}>+ Adicionar tarefa</button>
      {view.tasks.length === 0 && <p className="empty">Comece adicionando a primeira tarefa. Depois use <kbd>Enter</kbd> para criar as próximas e <kbd>Tab</kbd> para criar subtarefas.</p>}
    </section>
  )
}

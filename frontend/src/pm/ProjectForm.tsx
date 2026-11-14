import { useEffect, useRef, useState } from 'react'
import { shortEntity } from '../entity'
import type { PmMeta, PmProject } from './types'
import { addDays, todayIso } from './util'

export interface ProjectFormValue { name: string; description: string; entityId: number; entityName: string; startDate: string; endDate: string }

export default function ProjectForm({ meta, initial, defaultEntity, onSave, onClose }: {
  meta: PmMeta; initial?: PmProject; defaultEntity: number | null
  onSave: (v: ProjectFormValue) => Promise<void>; onClose: () => void
}) {
  const [v, setV] = useState<ProjectFormValue>(() => initial
    ? { name: initial.name, description: initial.description ?? '', entityId: initial.entityId, entityName: initial.entityName ?? '', startDate: initial.startDate, endDate: initial.endDate }
    : { name: '', description: '', entityId: defaultEntity ?? -1, entityName: '', startDate: todayIso(), endDate: addDays(todayIso(), 90) })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (v.entityId < 0) { setErr('Escolha a entidade.'); return }
    setBusy(true); setErr(null)
    try {
      await onSave({ ...v, entityName: meta.entities.find(x => x.id === v.entityId)?.name ?? v.entityName })
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); setBusy(false) }
  }
  const set = <K extends keyof ProjectFormValue>(k: K, val: ProjectFormValue[K]) => setV(x => ({ ...x, [k]: val }))

  return (
    <dialog ref={ref} className="pm-dialog" onClose={onClose} aria-labelledby="pf-title">
      <form onSubmit={submit}>
        <h2 id="pf-title">{initial ? 'Editar projeto' : 'Novo projeto'}</h2>
        <label>Nome<input required maxLength={200} value={v.name} onChange={e => set('name', e.target.value)} autoFocus /></label>
        <label>Entidade (ITSM)
          <select required value={v.entityId} onChange={e => set('entityId', Number(e.target.value))}>
            <option value={-1} disabled>Escolha…</option>
            {meta.entities.map(e => <option key={e.id} value={e.id} title={e.name}>{shortEntity(e.name)}</option>)}
          </select>
        </label>
        <div className="pm-row2">
          <label>Início do projeto<input type="date" required value={v.startDate} onChange={e => set('startDate', e.target.value)} /></label>
          <label>Fim do projeto<input type="date" required min={v.startDate} value={v.endDate} onChange={e => set('endDate', e.target.value)} /></label>
        </div>
        <label>Descrição<textarea rows={4} maxLength={20000} value={v.description} onChange={e => set('description', e.target.value)} /></label>
        {err && <div className="banner error">{err}</div>}
        <div className="pm-dialog-actions">
          <button type="button" onClick={() => ref.current?.close()}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : initial ? 'Salvar' : 'Criar projeto'}</button>
        </div>
      </form>
    </dialog>
  )
}

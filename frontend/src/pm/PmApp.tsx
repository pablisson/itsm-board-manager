import { useCallback, useEffect, useState } from 'react'
import SystemMenu from '../components/SystemMenu'
import { shortEntity } from '../entity'
import { pm } from './api'
import type { PmMeta } from './types'
import ProjectList from './ProjectList'
import ProjectView from './ProjectView'
import { type PmTab } from './route'
import './pm.css'

interface Route { projectId: number | null; tab: PmTab }
const parse = (): Route => {
  const m = /^#pm(?:\/(\d+)(?:\/(gantt|tarefas))?)?/.exec(location.hash)
  return { projectId: m?.[1] ? Number(m[1]) : null, tab: (m?.[2] as PmTab) ?? 'tarefas' }
}

const ENTITY_KEY = 'pm.entity'

export default function PmApp() {
  const [route, setRoute] = useState(parse)
  const [meta, setMeta] = useState<PmMeta | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [entity, setEntityState] = useState<number | null>(() => { try { const v = localStorage.getItem(ENTITY_KEY); return v ? Number(v) : null } catch { return null } })
  const setEntity = (e: number | null) => { setEntityState(e); try { if (e === null) localStorage.removeItem(ENTITY_KEY); else localStorage.setItem(ENTITY_KEY, String(e)) } catch { /* sem storage */ } }

  useEffect(() => { const f = () => setRoute(parse()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f) }, [])
  const loadMeta = useCallback(async (refresh = false) => {
    try { setMeta(await pm<PmMeta>('GET', `/meta${refresh ? '?refresh=true' : ''}`)); setMetaError(null) } catch (e) { setMetaError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void loadMeta() }, [loadMeta])
  useEffect(() => { const old = document.title; document.title = 'Gestão de Projetos'; return () => { document.title = old } }, [])

  return (
    <div className="app pm">
      <header className="top">
        <div>
          <SystemMenu current="pm" />
          <p className="meta">Projetos por entidade do ITSM · planejado × realizado · Gantt</p>
        </div>
        <div className="actions">
          <label className="pm-entity" title="Entidade">
            <span aria-hidden>🏢</span>
            <select value={entity ?? ''} onChange={e => setEntity(e.target.value === '' ? null : Number(e.target.value))} aria-label="Entidade">
              <option value="">Todas as entidades</option>
              {meta?.entities.map(e => <option key={e.id} value={e.id} title={e.name}>{shortEntity(e.name)}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => loadMeta(true)} title="Recarregar entidades, técnicos e status do ITSM">⟳ Dados do ITSM</button>
        </div>
      </header>

      {metaError && <div className="banner error">Falha ao carregar dados do ITSM: {metaError}</div>}
      {meta?.warning && <div className="banner warn">{meta.warning}</div>}

      {!meta ? <p className="empty center">Carregando…</p>
        : route.projectId
          ? <ProjectView key={route.projectId} id={route.projectId} tab={route.tab} meta={meta} />
          : <ProjectList meta={meta} entity={entity} />}
    </div>
  )
}

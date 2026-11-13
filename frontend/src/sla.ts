import type { BoardTicket } from './types'
import { formatDate, formatDuration } from './format'

/**
 * Estado do SLA calculado no navegador a partir dos prazos do ITSM (que já consideram o calendário da SLA).
 *   ok      → em aberto, dentro do prazo
 *   warn    → em aberto, resta ≤ 25% do prazo
 *   late    → em aberto, prazo estourado
 *   met     → cumprido no prazo
 *   missed  → cumprido fora do prazo
 *   paused  → chamado Pendente (o ITSM pausa o prazo de solução)
 */
export type SlaState = 'ok' | 'warn' | 'late' | 'met' | 'missed' | 'paused'
export interface SlaPart { state: SlaState; text: string; title: string }
export interface SlaInfo { tto: SlaPart | null; ttr: SlaPart | null; worst: SlaState | null }

const WARN_FRACTION = 0.25
const RANK: Record<SlaState, number> = { late: 5, missed: 4, warn: 3, paused: 2, ok: 1, met: 0 }
const dur = (ms: number) => formatDuration(Math.abs(ms) / 36e5)

function part(kind: string, name: string | null, dueIso: string | null, startIso: string | null | undefined,
  doneIso: string | null | undefined, paused: boolean, now: Date): SlaPart | null {
  if (!dueIso) return null
  const due = new Date(dueIso).getTime()
  const head = `${kind}${name ? ` · ${name}` : ''}\nPrazo: ${formatDate(dueIso)}`
  if (doneIso) {
    const diff = new Date(doneIso).getTime() - due
    return diff <= 0
      ? { state: 'met', text: 'no prazo', title: `${head}\nCumprido em ${formatDate(doneIso)}` }
      : { state: 'missed', text: `fora (+${dur(diff)})`, title: `${head}\nCumprido em ${formatDate(doneIso)} — ${dur(diff)} após o prazo` }
  }
  const left = due - now.getTime()
  if (paused) return { state: 'paused', text: 'pausado', title: `${head}\nChamado pendente: o ITSM pausa o prazo e o recalcula ao retomar` }
  if (left < 0) return { state: 'late', text: `estourou há ${dur(left)}`, title: `${head}\nEstourado há ${dur(left)}` }
  const total = startIso ? due - new Date(startIso).getTime() : 0
  const warn = total > 0 && left <= total * WARN_FRACTION
  return { state: warn ? 'warn' : 'ok', text: `vence em ${dur(left)}`, title: `${head}\nRestam ${dur(left)}` }
}

export function slaInfo(t: BoardTicket, now: Date): SlaInfo {
  const s = t.sla
  if (!s) return { tto: null, ttr: null, worst: null }
  const done = t.status === 5 || t.status === 6
  const end = done ? (t.solvedAtUtc ?? t.closedAtUtc) : null
  // atendimento: cumprido quando assumido; solucionado sem registro de atribuição conta como assumido na solução
  // pendente e ainda não assumido: o ITSM não conta como excedido → pausado
  const tto = part('Atendimento', s.ttoName, s.ttoDueUtc, t.openedAtUtc, s.ownedAtUtc ?? end, t.status === 4, now)
  const ttr = part('Solução', s.ttrName, s.ttrDueUtc, t.openedAtUtc, end, t.status === 4, now)
  const worst = [tto, ttr].filter((p): p is SlaPart => !!p).map(p => p.state).sort((a, b) => RANK[b] - RANK[a])[0] ?? null
  return { tto, ttr, worst }
}

export type SlaFilter = 'off' | 'all' | 'risk' | 'late'
export const SLA_DEFAULT: SlaFilter = 'off'
export const SLA_FILTERS: { id: SlaFilter; label: string; title: string }[] = [
  { id: 'off', label: 'Não mostrar', title: 'Oculta o SLA no board (padrão)' },
  { id: 'all', label: 'Todos', title: 'Mostra o SLA em todos os cards, sem filtrar' },
  { id: 'risk', label: 'Em risco', title: 'Em aberto com prazo estourado ou perto de vencer (≤ 25% do prazo)' },
  { id: 'late', label: 'Estourado', title: 'Prazo estourado (em aberto) ou cumprido fora do prazo' },
]
export function slaFilterMatch(f: SlaFilter, i: SlaInfo): boolean {
  if (f === 'off' || f === 'all') return true
  const states = [i.tto?.state, i.ttr?.state]
  return f === 'risk' ? states.some(s => s === 'late' || s === 'warn') : states.some(s => s === 'late' || s === 'missed')
}

import type { BoardSnapshot, BoardTicket } from './types'

export const NO_ENTITY = '(sem entidade)'

/** "GRUPO X > 0000 - MATRIZ > 0128 - CLIENTE" → "0128 - CLIENTE" (último nível da hierarquia). */
export function shortEntity(e?: string | null): string {
  if (!e) return NO_ENTITY
  const parts = e.split('>').map(p => p.trim()).filter(Boolean)
  return parts[parts.length - 1] ?? e
}

export type BoardColumnKey = 'unassigned' | 'inProgress' | 'blocked' | 'completed' | 'cancelled'

export const COLUMN_LABELS: Record<BoardColumnKey, string> = {
  unassigned: 'Sem atribuição', inProgress: 'Em andamento', blocked: 'Bloqueado', completed: 'Completo', cancelled: 'Cancelado',
}
export const COLUMN_TONES: Record<BoardColumnKey, string> = {
  unassigned: 'amber', inProgress: 'blue', blocked: 'red', completed: 'green', cancelled: 'gray',
}

export interface PlacedTicket { ticket: BoardTicket; column: BoardColumnKey }

/** Todos os tickets do snapshot, uma vez cada (um ticket com 2 técnicos aparece em 2 raias, mas conta 1 vez). */
export function placedTickets(snap: BoardSnapshot): PlacedTicket[] {
  const c = snap.columns
  const out: PlacedTicket[] = []
  const seen = new Set<number>()
  const push = (t: BoardTicket, column: BoardColumnKey) => { if (!seen.has(t.id)) { seen.add(t.id); out.push({ ticket: t, column }) } }
  c.unassigned.forEach(t => push(t, 'unassigned'))
  c.inProgress.forEach(l => l.tickets.forEach(t => push(t, 'inProgress')))
  c.blocked.forEach(t => push(t, 'blocked'))
  c.completed.forEach(t => push(t, 'completed'))
  c.cancelled.forEach(t => push(t, 'cancelled'))
  return out
}

export const entityKey = (t: BoardTicket) => t.entity ?? NO_ENTITY

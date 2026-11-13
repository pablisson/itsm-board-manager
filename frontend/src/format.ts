export function hoursBetween(fromIso?: string | null, to: Date = new Date()): number | null {
  if (!fromIso) return null
  const ms = to.getTime() - new Date(fromIso).getTime()
  return ms < 0 ? 0 : ms / 36e5
}

/** Tempo corrido (calendário, 24x7) — não considera calendário útil/SLA do ITSM. */
export function formatDuration(hours: number | null): string {
  if (hours === null) return '—'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  const d = Math.floor(hours / 24)
  const h = Math.floor(hours % 24)
  return d > 0 ? `${d}d ${h}h` : `${h}h`
}

const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
export const formatDate = (iso?: string | null) => (iso ? dtf.format(new Date(iso)) : '—')

/** URL absoluta da API pela origem (sem usuário:senha que o navegador recusaria em fetch). */
export const apiUrl = (path: string) => new URL(path, window.location.origin).toString()

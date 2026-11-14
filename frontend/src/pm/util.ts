/** Datas do projeto são "AAAA-MM-DD" (sem fuso). Toda conta é feita em UTC para não escorregar um dia. */
export const DAY = 86_400_000
export const toMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
export const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const addDays = (iso: string, n: number) => toIso(toMs(iso) + n * DAY)
export const diffDays = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY)
export const todayIso = () => { const d = new Date(); return toIso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) }

const dShort = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' })
const dLong = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
export const fmt = (iso: string | null | undefined) => (iso ? dShort.format(toMs(iso)) : '—')
export const fmtLong = (iso: string | null | undefined) => (iso ? dLong.format(toMs(iso)) : '—')
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n)}%`)

export const DEP_TYPES = [
  { id: 0, code: 'TI', label: 'Inicia após o término', help: 'Término → Início: só começa depois que a predecessora terminar.' },
  { id: 1, code: 'II', label: 'Inicia em paralelo', help: 'Início → Início: começa junto (ou depois) do início da predecessora.' },
  { id: 2, code: 'TT', label: 'Pode iniciar antes', help: 'Término → Término: pode começar antes, mas só termina depois que a predecessora terminar.' },
  { id: 3, code: 'IT', label: 'Termina após o início', help: 'Início → Término: só termina depois que a predecessora começar.' },
] as const
export const depCode = (type: number, lag: number) => `${DEP_TYPES[type]?.code ?? '?'}${lag ? (lag > 0 ? `+${lag}d` : `${lag}d`) : ''}`

export const MILESTONE_STATE: Record<string, { label: string; tone: string }> = {
  done: { label: 'Atingido', tone: 'green' },
  doneLate: { label: 'Atingido com atraso', tone: 'amber' },
  late: { label: 'Atrasado', tone: 'red' },
  risk: { label: 'Em risco', tone: 'amber' },
  open: { label: 'No prazo', tone: 'blue' },
}

export const fileSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`)

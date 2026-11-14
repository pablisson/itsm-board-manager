import { pct } from './util'

/** Barra dupla: realizado (preenchimento) × previsto para hoje (traço vertical). */
export default function ProgressPair({ progress, expected, compact }: { progress: number; expected: number | null; compact?: boolean }) {
  const gap = expected === null ? 0 : progress - expected
  const tone = expected === null ? 'blue' : gap >= -0.5 ? 'green' : gap < -15 ? 'red' : 'amber'
  const title = `Realizado ${pct(progress)} · previsto para hoje ${pct(expected)}${expected !== null ? ` · ${gap >= 0 ? '+' : ''}${Math.round(gap)} p.p.` : ''}`
  return (
    <span className={`pp${compact ? ' compact' : ''}`} title={title} aria-label={title} role="img">
      <span className="pp-bar">
        <span className={`pp-fill tone-${tone}`} style={{ width: `${Math.min(100, progress)}%` }} />
        {expected !== null && <span className="pp-mark" style={{ left: `${Math.min(100, expected)}%` }} />}
      </span>
      <span className="pp-text"><b>{pct(progress)}</b>{expected !== null && <span className="pp-exp"> / {pct(expected)}</span>}</span>
    </span>
  )
}

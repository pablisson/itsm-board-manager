import { lazy, Suspense, useEffect, useState } from 'react'
import App from './App'

const PmApp = lazy(() => import('./pm/PmApp'))
const isPm = () => /^#pm(\/|$)/.test(location.hash)

/** Escolhe o sistema pelo endereço: #pm… = Gestão de Projetos; o resto = Board ITSM. */
export default function Root() {
  const [pm, setPm] = useState(isPm)
  useEffect(() => {
    const f = () => setPm(isPm())
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return pm ? <Suspense fallback={<p className="empty center">Carregando…</p>}><PmApp /></Suspense> : <App />
}

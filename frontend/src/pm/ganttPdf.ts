import { jsPDF } from 'jspdf'
import { ganttRange, months } from './Gantt'
import type { PmMeta, PmProjectView, PmTask } from './types'
import { DAY, diffDays, fmt, MILESTONE_STATE, toIso, toMs } from './util'

type RGB = [number, number, number]
const C = {
  text: [29, 36, 51] as RGB, muted: [93, 102, 118] as RGB, grid: [223, 227, 234] as RGB, head: [244, 245, 247] as RGB, we: [246, 247, 250] as RGB,
  plan: [203, 213, 225] as RGB, planProg: [100, 116, 139] as RGB, sum: [30, 41, 59] as RGB,
  real: [37, 99, 235] as RGB, done: [21, 128, 61] as RGB, late: [198, 40, 40] as RGB, amber: [180, 83, 9] as RGB,
  today: [220, 38, 38] as RGB, proj: [100, 116, 139] as RGB, arrow: [71, 85, 105] as RGB,
}
const TONE: Record<string, RGB> = { green: C.done, amber: C.amber, red: C.late, blue: C.real }

/**
 * Gera o Gantt em PDF (A3 paisagem, vetorial). Escala de tempo ajustada ao período do projeto
 * (do início do mês de início até o fim do mês do término), linhas paginadas com o cabeçalho repetido.
 */
export function exportGanttPdf(view: PmProjectView, _meta: PmMeta, entityName: string) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' })
  const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight()
  const M = 10
  const COLS = { num: 13, name: 82, ps: 17, pe: 17, pct: 12 }
  const LEFTW = COLS.num + COLS.name + COLS.ps + COLS.pe + COLS.pct
  const X0 = M + LEFTW, TW = PW - M - X0
  const { start, end } = ganttRange(view, 0)
  const days = diffDays(start, end) + 1
  const dW = TW / days
  const xOf = (iso: string) => X0 + diffDays(start, iso) * dW
  const xEnd = (iso: string) => xOf(iso) + dW
  const mons = months(start, end)
  const ROW = 6.4, HEAD_M = 6, HEAD_D = dW >= 1.2 ? 5 : 0
  const tasks = view.tasks, ms = view.milestones, s = view.summary, p = view.project
  const firstWd = new Date(toMs(start)).getUTCDay()

  const fill = (c: RGB) => doc.setFillColor(c[0], c[1], c[2])
  const draw = (c: RGB) => doc.setDrawColor(c[0], c[1], c[2])
  const color = (c: RGB) => doc.setTextColor(c[0], c[1], c[2])
  const fit = (t: string, w: number) => {
    if (doc.getTextWidth(t) <= w) return t
    let lo = 0, hi = t.length
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (doc.getTextWidth(t.slice(0, mid) + '…') <= w) lo = mid; else hi = mid - 1 }
    return t.slice(0, lo) + '…'
  }
  const clean = (t: string) => t.replace(/[^\x20-\x7E -ÿ…]/g, '') // fontes padrão do PDF (WinAnsi)
  const diamond = (cx: number, cy: number, r: number) => { doc.triangle(cx - r, cy, cx, cy - r, cx + r, cy, 'F'); doc.triangle(cx - r, cy, cx, cy + r, cx + r, cy, 'F') }
  const check = (x: number, y: number) => { draw(C.done); doc.setLineWidth(0.45); doc.line(x, y, x + 0.9, y + 0.9); doc.line(x + 0.9, y + 0.9, x + 2.4, y - 0.9) }

  // ---------- cabeçalhos ----------
  const titleBlock = (first: boolean) => {
    color(C.text); doc.setFont('helvetica', 'bold'); doc.setFontSize(first ? 15 : 11)
    doc.text(fit(clean(p.name), PW - 2 * M - 120), M, M + 5)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); color(C.muted)
    const gen = new Date().toLocaleString('pt-BR')
    doc.text(clean(`${entityName} · Projeto: ${fmt(p.startDate)} a ${fmt(p.endDate)} · Gerado em ${gen}`), M, M + 10)
    if (first) {
      color(C.text); doc.setFont('helvetica', 'bold')
      const gap = s.expected === null ? '' : ` (${s.progress - s.expected >= 0 ? '+' : ''}${Math.round(s.progress - s.expected)} p.p.)`
      doc.text(clean(`Realizado ${Math.round(s.progress)}%  ·  Previsto para hoje ${s.expected === null ? '—' : Math.round(s.expected) + '%'}${gap}  ·  Tarefas concluídas ${s.done}/${s.tasks}  ·  Atrasadas ${s.late}  ·  Término previsto ${fmt(s.forecast)}  ·  Marcos ${s.milestonesDone}/${s.milestones}`), M, M + 15)
      doc.setFont('helvetica', 'normal')
    }
    legend(PW - M, M + 4)
    return first ? M + 19 : M + 14
  }

  const legend = (right: number, y: number) => {
    doc.setFontSize(7); color(C.muted)
    const items: [string, (x: number, y: number) => void][] = [
      ['Planejado', (x, yy) => { fill(C.plan); doc.rect(x, yy - 1.8, 6, 2, 'F') }],
      ['% realizado', (x, yy) => { fill(C.planProg); doc.rect(x, yy - 1.8, 6, 2, 'F') }],
      ['Executado', (x, yy) => { fill(C.real); doc.rect(x, yy - 1.6, 6, 1.6, 'F') }],
      ['Com atraso', (x, yy) => { fill(C.late); doc.rect(x, yy - 1.6, 6, 1.6, 'F') }],
      ['Concluída', (x, yy) => { fill(C.done); doc.rect(x, yy - 1.6, 6, 1.6, 'F') }],
      ['Marco', (x, yy) => { fill(C.amber); diamond(x + 3, yy - 0.8, 1.4) }],
      ['Hoje', (x, yy) => { draw(C.today); doc.setLineWidth(0.5); doc.line(x + 3, yy - 2.5, x + 3, yy + 0.6) }],
    ]
    let x = right
    for (const [label] of [...items].reverse()) x -= doc.getTextWidth(label) + 10
    for (const [label, icon] of items) { icon(x, y); color(C.muted); doc.text(label, x + 7.5, y); x += doc.getTextWidth(label) + 10 }
  }

  const gridHeader = (y: number) => {
    fill(C.head); doc.rect(M, y, PW - 2 * M, HEAD_M + HEAD_D, 'F')
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); color(C.muted)
    const ty = y + (HEAD_M + HEAD_D) / 2 + 1.2
    let cx = M + 1.5
    doc.text('Nº', cx, ty); cx += COLS.num
    doc.text('Tarefa', cx, ty); cx += COLS.name
    doc.text('Início plan.', cx, ty); cx += COLS.ps
    doc.text('Fim plan.', cx, ty); cx += COLS.pe
    doc.text('Real.', cx, ty)
    doc.setFont('helvetica', 'normal')
    for (const m of mons) {
      const mx = X0 + m.offset * dW, mw = m.days * dW
      draw(C.grid); doc.setLineWidth(0.2); doc.line(mx, y, mx, y + HEAD_M + HEAD_D)
      color(C.text); doc.setFontSize(mw > 18 ? 7.5 : 6)
      const label = mw > 18 ? clean(m.label) : m.iso.slice(5, 7) + '/' + m.iso.slice(2, 4)
      if (mw > 6) doc.text(fit(label, mw - 1), mx + mw / 2, y + 4.2, { align: 'center' })
    }
    if (HEAD_D) {
      doc.setFontSize(dW >= 3.2 ? 5.5 : 5); color(C.muted)
      for (let i = 0; i < days; i++) {
        const d = new Date(toMs(start) + i * DAY), wd = d.getUTCDay(), dn = d.getUTCDate()
        const show = dW >= 3.2 || (dW >= 1.2 && wd === 1) // todos os dias ou só as segundas
        if (show) doc.text(String(dn), X0 + i * dW + dW / 2, y + HEAD_M + 3.6, { align: 'center' })
      }
    }
    draw(C.grid); doc.setLineWidth(0.3); doc.line(M, y + HEAD_M + HEAD_D, PW - M, y + HEAD_M + HEAD_D)
    return y + HEAD_M + HEAD_D
  }

  // ---------- paginação ----------
  const rows: ({ kind: 'ms' } | { kind: 'task'; t: PmTask })[] = [{ kind: 'ms' }, ...tasks.map(t => ({ kind: 'task' as const, t }))]
  const pages: typeof rows[] = []
  {
    let i = 0, first = true
    while (i < rows.length) {
      const top = (first ? M + 19 : M + 14) + HEAD_M + HEAD_D
      const n = Math.max(1, Math.floor((PH - M - 8 - top) / ROW))
      pages.push(rows.slice(i, i + n)); i += n; first = false
    }
  }

  pages.forEach((pageRows, pi) => {
    if (pi > 0) doc.addPage()
    const y0 = gridHeader(titleBlock(pi === 0))
    const yEnd = y0 + pageRows.length * ROW

    // fundo: fins de semana, meses, zebra
    if (dW >= 1) {
      fill(C.we)
      for (let i = 0; i < days; i++) { const wd = (firstWd + i) % 7; if (wd === 0 || wd === 6) doc.rect(X0 + i * dW, y0, dW, yEnd - y0, 'F') }
    }
    draw(C.grid); doc.setLineWidth(0.15)
    for (const m of mons) doc.line(X0 + m.offset * dW, y0, X0 + m.offset * dW, yEnd)
    pageRows.forEach((_, r) => doc.line(M, y0 + (r + 1) * ROW, PW - M, y0 + (r + 1) * ROW))
    doc.setLineWidth(0.3); doc.line(X0, y0 - HEAD_M - HEAD_D, X0, yEnd)

    // linhas verticais: projeto, marcos, hoje
    doc.setLineDashPattern([1, 1], 0); draw(C.proj); doc.setLineWidth(0.3)
    doc.line(xOf(p.startDate), y0, xOf(p.startDate), yEnd); doc.line(xEnd(p.endDate), y0, xEnd(p.endDate), yEnd)
    for (const m of ms) { const c = TONE[MILESTONE_STATE[m.state]?.tone ?? 'blue']!; draw(c); doc.line(xOf(m.dueDate) + dW / 2, y0, xOf(m.dueDate) + dW / 2, yEnd) }
    doc.setLineDashPattern([], 0)
    if (view.today >= start && view.today <= end) { draw(C.today); doc.setLineWidth(0.45); const tx = xOf(view.today) + dW / 2; doc.line(tx, y0 - HEAD_D, tx, yEnd) }

    const rowY = new Map<number, number>()
    pageRows.forEach((row, r) => {
      const y = y0 + r * ROW
      doc.setFontSize(7.5)
      if (row.kind === 'ms') {
        color(C.text); doc.setFont('helvetica', 'bold'); doc.text('Marcos', M + 1.5 + COLS.num, y + 4.3); doc.setFont('helvetica', 'normal')
        for (const m of ms) {
          const c = TONE[MILESTONE_STATE[m.state]?.tone ?? 'blue']!
          const cx = xOf(m.dueDate) + dW / 2
          fill(c); diamond(cx, y + ROW / 2, 1.8)
          color(C.text); doc.setFontSize(6.5)
          doc.text(fit(clean(`${m.name} (${fmt(m.dueDate)})`), 60), cx + 2.6, y + 4.1)
        }
        return
      }
      const t = row.t
      rowY.set(t.id, y)
      // colunas da esquerda
      color(t.done ? C.done : C.text)
      doc.setFont('helvetica', t.isSummary ? 'bold' : 'normal')
      doc.text(t.wbs, M + 1.5, y + 4.3)
      const indent = t.level * 3.2
      const nameX = M + COLS.num + 1.5 + indent
      if (t.done) check(nameX, y + 3.3)
      doc.text(fit(clean(t.title), COLS.name - 3 - indent - (t.done ? 3.4 : 0)), nameX + (t.done ? 3.4 : 0), y + 4.3)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); color(t.late ? C.late : C.muted)
      doc.text(fmt(t.planStart), M + COLS.num + COLS.name + 1, y + 4.3)
      doc.text(fmt(t.planEnd), M + COLS.num + COLS.name + COLS.ps + 1, y + 4.3)
      color(t.expected !== null && t.progress + 0.5 < t.expected ? C.late : C.text)
      doc.text(`${Math.round(t.progress)}%`, M + LEFTW - 1.5, y + 4.3, { align: 'right' })

      // barras
      if (t.planStart && t.planEnd) {
        const bx = xOf(t.planStart), bw = Math.max(dW, xEnd(t.planEnd) - bx)
        if (t.isSummary) {
          fill(C.sum); doc.rect(bx, y + 1.3, bw, 1.3, 'F')
          doc.triangle(bx, y + 2.6, bx + 1.4, y + 2.6, bx, y + 3.9, 'F'); doc.triangle(bx + bw, y + 2.6, bx + bw - 1.4, y + 2.6, bx + bw, y + 3.9, 'F')
        } else {
          fill(t.late ? [254, 202, 202] : C.plan); doc.rect(bx, y + 1.0, bw, 2.4, 'F')
          if (t.progress > 0) { fill(C.planProg); doc.rect(bx, y + 1.0, bw * Math.min(100, t.progress) / 100, 2.4, 'F') }
        }
      }
      const re = t.realEnd ?? (t.realStart && !t.done ? view.today : null)
      if (t.realStart && re) {
        const late = !t.done && !!t.planEnd && view.today > t.planEnd
        fill(t.done ? C.done : late ? C.late : C.real)
        const bx = xOf(t.realStart)
        doc.rect(bx, y + 3.9, Math.max(dW / 2, xEnd(re) - bx), t.isSummary ? 1.3 : 1.8, 'F')
      }
      const lastX = Math.max(t.planEnd ? xEnd(t.planEnd) : 0, re ? xEnd(re) : 0)
      if (lastX && lastX < PW - M - 4) {
        doc.setFontSize(6); color(t.done ? C.done : C.muted)
        if (t.done) check(lastX + 1, y + 3.3)
        const lbl = t.done ? fmt(t.realEnd) : t.assignees.map(a => a.name.split(' ')[0]).join(', ')
        if (lbl) doc.text(fit(clean(lbl), PW - M - lastX - (t.done ? 5 : 2)), lastX + (t.done ? 4.2 : 1.2), y + 4.3)
      }
    })

    // setas de dependência (quando as duas pontas estão nesta página)
    doc.setLineWidth(0.25)
    for (const d of view.dependencies) {
      const pY = rowY.get(d.predId), sY = rowY.get(d.succId)
      const pt = tasks.find(x => x.id === d.predId), st = tasks.find(x => x.id === d.succId)
      if (pY === undefined || sY === undefined || !pt || !st) continue
      const ax = (t: PmTask, side: 'start' | 'end') => { const a = t.planStart ?? t.realStart, b = t.planEnd ?? t.realEnd ?? a; return a && b ? (side === 'start' ? xOf(a) : xEnd(b)) : null }
      const x1 = ax(pt, d.type === 1 || d.type === 3 ? 'start' : 'end'), x2 = ax(st, d.type === 0 || d.type === 1 ? 'start' : 'end')
      if (x1 === null || x2 === null) continue
      const y1 = pY + 2.2, y2 = sY + 2.2
      const out = d.type === 1 || d.type === 3 ? -1.6 : 1.6, inn = d.type === 0 || d.type === 1 ? -1.6 : 1.6
      const c = d.violated ? C.late : C.arrow
      draw(c); fill(c)
      const pts: [number, number][] = (out > 0 ? x2 + inn >= x1 + out : x2 + inn <= x1 + out)
        ? [[x1, y1], [x1 + out, y1], [x1 + out, y2], [x2, y2]]
        : [[x1, y1], [x1 + out, y1], [x1 + out, (y1 + y2) / 2], [x2 + inn, (y1 + y2) / 2], [x2 + inn, y2], [x2, y2]]
      for (let k = 0; k < pts.length - 1; k++) doc.line(pts[k]![0], pts[k]![1], pts[k + 1]![0], pts[k + 1]![1])
      const dir = inn < 0 ? 1 : -1 // seta aponta para dentro da barra
      doc.triangle(x2, y2, x2 - dir * 1.4, y2 - 0.8, x2 - dir * 1.4, y2 + 0.8, 'F')
    }

    // rodapé
    doc.setFontSize(7); color(C.muted)
    doc.text(clean(`${p.name} · Gantt · escala ${fmt(start)} a ${fmt(end)}`), M, PH - 5)
    doc.text(`Página ${pi + 1} de ${pages.length}`, PW - M, PH - 5, { align: 'right' })
  })

  const safe = p.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'projeto'
  doc.save(`gantt-${safe}-${toIso(Date.now())}.pdf`)
}

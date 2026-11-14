export interface PersonRef { id: number; name: string }
export interface BoardTicket {
  id: number; title: string; status: number; statusLabel: string
  priority?: number | null; priorityLabel?: string | null
  category?: string | null; entity?: string | null
  openedAtUtc?: string | null; updatedAtUtc?: string | null
  solvedAtUtc?: string | null; closedAtUtc?: string | null
  technicians: PersonRef[]; assignedGroups: string[]
  solutionTypeId?: number | null; solutionType?: string | null
  url: string; flags: string[]
  sla?: BoardSla | null
}
export interface BoardSla {
  ttoName: string | null; ttrName: string | null
  ttoDueUtc: string | null; ttrDueUtc: string | null
  /** quando foi assumido; null = ainda não assumido */
  ownedAtUtc: string | null
}
export interface TechnicianLane { id: number; name: string; tickets: BoardTicket[] }
export interface BoardSnapshot {
  syncedAtUtc: string; durationMs: number; glpiHost: string; doneDays: number
  cancelledConfigured: boolean; ageWarnHours: number; ageCriticalHours: number
  columns: { unassigned: BoardTicket[]; inProgress: TechnicianLane[]; blocked: BoardTicket[]; completed: BoardTicket[]; cancelled: BoardTicket[] }
  totals: Record<string, number>; warnings: string[]
}
export interface BoardResponse {
  snapshot: BoardSnapshot | null; lastError: string | null; lastErrorAtUtc: string | null
  stale: boolean; throttledSeconds?: number | null
}
export interface MonthlyEntityRow { entity: string; counts: number[]; total: number }
export interface MonthlyReport {
  generatedAtUtc: string; durationMs: number; months: string[]
  rows: MonthlyEntityRow[]; monthTotals: number[]; grandTotal: number
}
export interface MonthlyReportResponse { report: MonthlyReport | null; error: string | null; throttledSeconds?: number | null }
export interface StatusSegment { status: number; label: string; fromUtc: string; toUtc: string | null }
export type TimelineEventKind = 'status' | 'followup' | 'task' | 'solution' | 'assign' | 'document'
export interface TimelineEvent { atUtc: string; kind: TimelineEventKind; label: string; user: string | null; fromStatus?: number | null; toStatus?: number | null }
export interface TimelineTicket {
  id: number; title: string; entity: string | null; status: number; statusLabel: string; url: string
  openedAtUtc: string | null; endAtUtc: string | null; lastUpdateUtc: string | null
  segments: StatusSegment[]; events: TimelineEvent[]
}
export interface TimelineResponse {
  technician: PersonRef | null; generatedAtUtc: string; durationMs: number; doneDays: number
  tickets: TimelineTicket[]; warnings: string[]; error?: string | null
}

export interface SlaReportTicket {
  id: number; title: string; status: number; statusLabel: string; entity: string | null; url: string; techIds: number[]
  openedAtUtc: string | null; takenAtUtc: string | null; solvedAtUtc: string | null
  ttoName: string | null; ttrName: string | null; ttoDueUtc: string | null; ttrDueUtc: string | null
  ttoLate: boolean; ttrLate: boolean
  takeDelaySec: number | null; solveDelaySec: number | null; waitingSec: number | null; actionTimeSec: number | null
}
export interface SlaReport {
  generatedAtUtc: string; durationMs: number; from: string; to: string
  technicians: PersonRef[]; tickets: SlaReportTicket[]; warnings: string[]
}
export interface SlaReportResponse { report: SlaReport | null; error: string | null; throttledSeconds?: number | null }

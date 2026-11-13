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

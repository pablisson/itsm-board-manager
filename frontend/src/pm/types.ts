export interface PmPerson { id: number; name: string }
export interface PmState { id: number; name: string; label: string; color: string | null; isFinished: boolean }
export interface PmEntity { id: number; name: string }
export interface PmMeta { states: PmState[]; entities: PmEntity[]; users: PmPerson[]; warning: string | null; itsmUrl: string | null }

export interface PmProject {
  id: number; name: string; description: string | null; entityId: number; entityName: string | null
  startDate: string; endDate: string; glpiProjectId: number | null; glpiSyncedAt: string | null; updatedAt: string
}
export interface PmChecklistItem { id: number; taskId: number; text: string; done: boolean; position: number }
export interface PmAttachment { id: number; taskId: number; fileName: string; contentType: string | null; size: number; createdAt: string }
export interface PmTask {
  id: number; seq: number; level: number; wbs: string; parentId: number | null; isSummary: boolean
  title: string; description: string | null
  planStart: string | null; planEnd: string | null; realStart: string | null; realEnd: string | null
  statusId: number; done: boolean; percent: number; progress: number; expected: number | null
  startVarDays: number | null; endVarDays: number | null; late: boolean; outOfProject: boolean
  assignees: PmPerson[]; checklist: PmChecklistItem[]; attachments: PmAttachment[]
  glpiTaskId: number | null; glpiSyncedAt: string | null; glpiPending: boolean
}
export interface PmDependency { id: number; predId: number; succId: number; type: number; lagDays: number; violated: boolean; glpiLinkId: number | null }
export type MilestoneState = 'done' | 'doneLate' | 'late' | 'risk' | 'open'
export interface PmMilestone {
  id: number; name: string; objective: string | null; dueDate: string; taskIds: number[]
  state: MilestoneState; forecast: string | null; doneDate: string | null; progress: number
}
export interface PmSummary {
  progress: number; expected: number | null; tasks: number; done: number; late: number; inProgress: number
  planStart: string | null; planEnd: string | null; realStart: string | null; realEnd: string | null; forecast: string | null
  milestones: number; milestonesDone: number
}
export interface PmProjectView {
  project: PmProject; summary: PmSummary; tasks: PmTask[]; dependencies: PmDependency[]; milestones: PmMilestone[]
  today: string; messages: string[]
}
export interface PmProjectListItem { project: PmProject; summary: PmSummary }

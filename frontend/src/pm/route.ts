export type PmTab = 'tarefas' | 'gantt'

export const go = (projectId: number | null, tab: PmTab = 'tarefas') => {
  location.hash = projectId ? `pm/${projectId}${tab === 'gantt' ? '/gantt' : ''}` : 'pm'
}

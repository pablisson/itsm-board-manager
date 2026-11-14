import { apiUrl } from '../format'

export class ApiError extends Error {}

/** Chamada à API da gestão de projetos (o cabeçalho X-Requested-With é exigido nas alterações — proteção CSRF). */
export async function pm<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl('/api/pm' + path), {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'board', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(data?.errors?.join(' ') ?? `Erro HTTP ${res.status}`)
  return data as T
}

export async function pmUpload<T>(path: string, files: FileList | File[]): Promise<T> {
  const form = new FormData()
  for (const f of Array.from(files)) form.append('files', f, f.name)
  const res = await fetch(apiUrl('/api/pm' + path), { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'board' }, body: form })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(data?.errors?.join(' ') ?? `Erro HTTP ${res.status}`)
  return data as T
}

export const attachmentUrl = (id: number) => apiUrl(`/api/pm/attachments/${id}`)

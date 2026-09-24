// Тонкая обёртка над fetch. Авторизация — httpOnly-cookie сессии, её ставит бэкенд.

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const UNAUTHORIZED_EVENT = 'api:unauthorized'

function errorMessage(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    // Ошибки валидации FastAPI: [{loc, msg}]
    return detail.map((item: { msg?: string }) => item.msg ?? '').filter(Boolean).join('; ') || 'Некорректные данные'
  }
  if (status >= 500) return 'Сервер временно недоступен. Попробуйте ещё раз.'
  return `Ошибка запроса (${status})`
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(`/api${path}`, init)
  } catch {
    throw new ApiError(0, 'Нет соединения с сервером')
  }

  if (response.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  if (response.status === 204) return undefined as T

  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, errorMessage(response.status, payload))
  return payload as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: (path: string) => request<void>('DELETE', path),
}

export function exportUrl(variantId: string, format: 'pptx' | 'pdf' | 'html'): string {
  return `/api/variants/${variantId}/export/${format}`
}

export function contentFileUrl(presentationId: string, fileId: string): string {
  return `/api/presentations/${presentationId}/files/${fileId}/content`
}

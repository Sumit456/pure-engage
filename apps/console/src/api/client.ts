// Thin fetch wrapper for the Pure Engage API. Sends the session cookie (same origin) and the CSRF header.
export interface FieldIssue { path: string; message: string }

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  /** Field-level problems from a 400, keyed by field path. */
  fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries((this.details as FieldIssue[]).filter((d) => d?.path).map((d) => [d.path, d.message]));
  }
}

export async function api<T>(path: string, { method = 'GET', body, signal }: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'x-pe-csrf': '1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.details);
  return json as T;
}

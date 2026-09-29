export type ResponseGuard<T> = (value: unknown) => value is T;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isRecordArray<T>(guard: ResponseGuard<T>): ResponseGuard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

function responseMessage(value: unknown, status: number): string {
  if (isRecord(value)) {
    if (typeof value.active_run_id === 'string') return `Target reserved by run ${value.active_run_id}`;
    if (typeof value.message === 'string' && value.message.length) return value.message;
  }
  return `Request failed (HTTP ${status})`;
}

export class ApiResponseError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly activeRunId?: string, readonly reason?: string) { super(message); }
}

function responseError(value: unknown, status: number): ApiResponseError {
  return new ApiResponseError(responseMessage(value, status), status,
    isRecord(value) && typeof value.code === 'string' ? value.code : undefined,
    isRecord(value) && typeof value.active_run_id === 'string' ? value.active_run_id : undefined,
    isRecord(value) && typeof value.reason === 'string' ? value.reason : undefined);
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new Error('API unavailable. Check the service and retry.');
  }
}

export async function requestJson<T>(path: string, guard: ResponseGuard<T>, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { payload = undefined; }
  if (!response.ok) throw responseError(payload, response.status);
  if (!guard(payload)) throw new Error(`Unexpected response from ${path}`);
  return payload;
}

export async function requestOk(path: string, init?: RequestInit): Promise<void> {
  const response = await send(path, init);
  if (response.ok) return;
  let payload: unknown;
  try { payload = await response.json(); }
  catch { payload = undefined; }
  throw responseError(payload, response.status);
}

import { performance } from 'node:perf_hooks';

export const DEADLINE_MS = {
  handshake: 15_000,
  upload: 30_000,
  // Extraction (30 s) and guideline search (15 s) are target-internal lanes;
  // this auditor calls only the documented 90-second turn endpoint.
  turn: 90_000,
  catalog: 15_000,
  localRole: 90_000,
  paidRole: 30_000
} as const;

export type TargetDeadlineLimits = { handshake?: number; upload?: number; turn?: number };
export type DeadlineInfo = { stage: string; elapsedMs: number; limitMs: number; attempted: boolean };

export class DeadlineExceeded extends Error {
  readonly info: DeadlineInfo;
  constructor(stage: string, elapsedMs: number, limitMs: number, attempted: boolean) {
    super(`Deadline exceeded at ${stage}`);
    this.info = { stage, elapsedMs, limitMs, attempted };
  }
}

export function boundedLimit(value: number | undefined, maximum: number): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error('Invalid operation deadline');
  return limit;
}

export async function withinDeadline<T>(stage: string, maximumMs: number, runUntil: number | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  boundedLimit(maximumMs, maximumMs);
  if (runUntil !== undefined && (!Number.isSafeInteger(runUntil) || runUntil < 0)) throw new Error('Invalid run deadline');
  const started = performance.now();
  const remaining = runUntil === undefined ? maximumMs : Math.min(maximumMs, runUntil - Date.now());
  if (remaining <= 0) throw new DeadlineExceeded(stage, 0, 0, false);
  const limitMs = Math.max(1, Math.ceil(remaining));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceeded(stage, Math.round(performance.now() - started), limitMs, true));
    }, limitMs);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } catch (error) {
    if (controller.signal.aborted) throw new DeadlineExceeded(stage, Math.round(performance.now() - started), limitMs, true);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

export function discardResponse(response: Response): void {
  if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
}

export async function readBodyText(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('Response body exceeded limit'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* Abort may still be canceling the body. */ }
  }
}

export async function readJsonBody(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBodyText(response, signal, maxBytes)) as unknown;
}

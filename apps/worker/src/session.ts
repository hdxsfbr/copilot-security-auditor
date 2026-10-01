import { observationV2, type Observation } from '../../../packages/contracts/src/index.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  boundedLimit,
  DEADLINE_MS,
  DeadlineExceeded,
  discardResponse,
  readBodyText,
  readJsonBody,
  withinDeadline,
  type DeadlineInfo,
  type TargetDeadlineLimits,
} from './deadlines.js';

export const MAX_TURN_RESPONSE_BYTES = 256_000;
export const MAX_VISIBLE_CHARS = 10_000;
type SourceField = 'source' | 'sources' | 'citation' | 'citations';
type SourceEvidence = Extract<Observation, { v: 2 }>['claims'][number]['sources'][number];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value: unknown, max = 120): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
function sourceEvidence(
  value: unknown,
  field: SourceField,
  claimKind?: string,
): SourceEvidence | null {
  if (!record(value)) return null;
  const kind = boundedString(value.kind) ?? boundedString(value.type) ?? claimKind;
  const documentSourceId = boundedString(value.source_id, 500);
  const documentPage = value.page ?? value.page_number;
  const locator =
    kind === 'chart_fact'
      ? (boundedString(value.record_id, 500) ?? boundedString(value.id, 500))
      : kind === 'document_extract'
        ? documentSourceId && Number.isSafeInteger(documentPage) && Number(documentPage) > 0
          ? `${documentSourceId}#page=${documentPage}`
          : undefined
        : kind === 'guideline_reference'
          ? boundedString(value.publisher, 500) &&
            boundedString(value.title, 500) &&
            boundedString(value.section, 500)
            ? `${value.publisher}: ${value.title}, ${value.section}`
            : undefined
          : undefined;
  // This is a recognized reference shape, not independent proof of the cited fact.
  return { field, kind, locator, support: locator ? 'supported' : 'unsupported', metadata: value };
}
function claimSources(claim: Record<string, unknown>, kind?: string): SourceEvidence[] {
  const sources: SourceEvidence[] = [];
  for (const field of ['source', 'sources', 'citation', 'citations'] as const) {
    if (!(field in claim)) continue;
    const values = Array.isArray(claim[field]) ? (claim[field] as unknown[]) : [claim[field]];
    for (const value of values) {
      const normalized = sourceEvidence(value, field, kind);
      if (normalized) sources.push(normalized);
      else sources.push({ field, support: 'unsupported', metadata: { unsupportedValue: value } });
    }
  }
  return sources;
}
async function boundedTurnJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new TargetFailure('incomplete', 'Missing target turn body');
  if (signal.aborted) {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* Cancellation may still be pending. */
    }
    throw new TargetFailure('incomplete', 'Target turn body arrived after deadline');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TURN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new TargetFailure('incomplete', 'Target turn body exceeded evidence limit');
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (record(parsed)) return parsed;
  } catch (error) {
    if (error instanceof TargetFailure) throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    try {
      reader.releaseLock();
    } catch {
      /* Abort may still be canceling the body. */
    }
  }
  throw new TargetFailure('incomplete', 'Malformed target turn body');
}

export type Identity = { username: string; password: string; pubpid: string };
export class TargetFailure extends Error {
  constructor(
    readonly kind: 'blocked' | 'incomplete',
    message: string,
    readonly timeout?: DeadlineInfo,
  ) {
    super(message);
  }
}
export type Attempt = {
  number: number;
  outcome: 'observed' | 'unprocessed' | 'ambiguous';
  status?: number;
};
export class TurnFailure extends TargetFailure {
  constructor(
    readonly attempts: Attempt[],
    reason = 'Turn delivery uncertain or rejected',
    timeout?: DeadlineInfo,
  ) {
    super('incomplete', reason, timeout);
  }
}

export type SessionOptions = { runUntil?: number; limits?: TargetDeadlineLimits };

export class Session {
  private cookies = new Map<string, string>();
  private csrf = '';
  private conversation = '';
  private issuedTickets: string[] = [];
  private readonly limits: { handshake: number; upload: number; turn: number };
  lastTimeout: DeadlineInfo | null = null;
  version = 'unknown';
  assignedPid: number | null = null;
  constructor(
    readonly baseUrl: string,
    readonly user: Identity,
    readonly transport: typeof fetch = fetch,
    readonly options: SessionOptions = {},
  ) {
    this.limits = {
      handshake: boundedLimit(options.limits?.handshake, DEADLINE_MS.handshake),
      upload: boundedLimit(options.limits?.upload, DEADLINE_MS.upload),
      turn: boundedLimit(options.limits?.turn, DEADLINE_MS.turn),
    };
    if (
      options.runUntil !== undefined &&
      (!Number.isSafeInteger(options.runUntil) || options.runUntil < 0)
    )
      throw new Error('Invalid run deadline');
  }
  secrets() {
    return [this.user.password, this.csrf, ...this.cookies.values(), ...this.issuedTickets].filter(
      Boolean,
    );
  }
  private url(path: string) {
    return new URL(path, this.baseUrl.replace(/\/?$/, '/')).toString();
  }
  private timed<T>(
    stage: string,
    kind: keyof Session['limits'],
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    return withinDeadline(stage, this.limits[kind], this.options.runUntil, work);
  }
  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    const response = await this.transport(this.url(path), {
      ...init,
      redirect: 'manual',
      signal,
      headers: {
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...init.headers,
      },
    });
    if (signal?.aborted) {
      discardResponse(response);
      throw new Error('Target response arrived after deadline');
    }
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const split = pair.indexOf('=');
      if (split > 0) this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  private async requestHeaders(path: string, init: RequestInit, signal: AbortSignal) {
    const response = await this.request(path, init, signal);
    discardResponse(response);
    return response;
  }
  private form(fields: Record<string, string>) {
    return new URLSearchParams(fields);
  }
  private jsonBody(fields: Record<string, string>): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    };
  }
  private async resolvePid(pubpid = this.user.pubpid): Promise<number> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(pubpid))
      throw new TargetFailure('blocked', 'Invalid external patient ID');
    // OpenEMR's authenticated patient finder: searchType=true uses LIKE without
    // a suffix; restrict sColumns to pubpid and require the full filtered count.
    const query = new URLSearchParams({
      sColumns: 'pubpid',
      sSearch: pubpid,
      searchType: 'true',
      iDisplayStart: '0',
      iDisplayLength: '2',
      sEcho: '1',
    });
    let data: Record<string, unknown>;
    try {
      data = await this.timed('target.finder', 'handshake', async signal => {
        const response = await this.request(
          `interface/main/finder/dynamic_finder_ajax.php?${query}`,
          {},
          signal,
        );
        if (!response.ok) {
          discardResponse(response);
          throw new TargetFailure('blocked', 'External patient ID lookup unavailable');
        }
        return this.json(response, signal);
      });
    } catch (error) {
      if (error instanceof DeadlineExceeded)
        throw new TargetFailure('blocked', error.message, error.info);
      if (error instanceof TargetFailure && error.kind === 'blocked') throw error;
      throw new TargetFailure('blocked', 'External patient ID lookup invalid');
    }
    const row = Array.isArray(data.aaData) && data.aaData.length === 1 ? data.aaData[0] : null;
    const count = data.iTotalDisplayRecords;
    if (
      (count !== 1 && count !== '1') ||
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      row.DT_RowId === undefined
    ) {
      // aaData is an array of rows; each row carries DT_RowId and index 0.
      throw new TargetFailure('blocked', 'External patient ID not uniquely resolved');
    }
    const fields = row as Record<string, unknown>;
    const match =
      typeof fields.DT_RowId === 'string' ? /^pid_([1-9][0-9]*)$/.exec(fields.DT_RowId) : null;
    const pid = match ? Number(match[1]) : NaN;
    if (fields['0'] !== pubpid || !Number.isSafeInteger(pid))
      throw new TargetFailure('blocked', 'External patient ID lookup mismatch');
    return pid;
  }
  async cannotAccess(pubpid: string) {
    try {
      await this.resolvePid(pubpid);
      return false;
    } catch (e) {
      if (e instanceof TargetFailure && e.message === 'External patient ID not uniquely resolved')
        return true;
      throw e;
    }
  }
  async chartReportFingerprint(): Promise<string | null> {
    this.lastTimeout = null;
    if (this.assignedPid === null) return null;
    try {
      return await this.timed('target.report', 'handshake', async signal => {
        const response = await this.request(
          'interface/patient_file/report/patient_report.php',
          {},
          signal,
        );
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
          discardResponse(response);
          return null;
        }
        if (Number(response.headers.get('content-length') ?? 0) > 2_000_000) {
          discardResponse(response);
          return null;
        }
        const html = await readBodyText(response, signal, 2_000_000);
        if (!html || html.length > 2_000_000 || !/\border(?:s|ing)?\b/i.test(html)) return null;
        return createHash('sha256').update(html).digest('hex');
      });
    } catch (error) {
      if (error instanceof DeadlineExceeded) this.lastTimeout = error.info;
      return null;
    }
  }
  private async json(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const value = await readJsonBody(response, signal, 1_000_000);
      if (value && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      /* malformed target response */
    }
    throw new TargetFailure('incomplete', 'Malformed target response');
  }
  async open() {
    try {
      const ready = await this.timed('target.ready', 'handshake', signal =>
        this.requestHeaders('copilot-api/ready', {}, signal),
      );
      if (!ready.ok) throw new TargetFailure('blocked', 'Target not ready');
      const login = await this.timed('target.login', 'handshake', signal =>
        this.requestHeaders(
          'interface/main/main_screen.php?auth=login&site=default',
          {
            method: 'POST',
            body: this.form({
              new_login_session_management: '1',
              languageChoice: '1',
              authUser: this.user.username,
              clearPass: this.user.password,
            }),
          },
          signal,
        ),
      );
      if (login.status !== 302) throw new TargetFailure('blocked', 'Test user login failed');
      const pid = await this.resolvePid();
      this.assignedPid = pid;
      const chart = await this.timed('target.chart', 'handshake', signal =>
        this.requestHeaders(
          `interface/patient_file/summary/demographics.php?set_pid=${pid}`,
          {},
          signal,
        ),
      );
      if (!chart.ok) throw new TargetFailure('blocked', 'Assigned chart unavailable');
      const data = await this.timed('target.session', 'handshake', async signal => {
        const session = await this.request(
          'interface/modules/custom_modules/oe-module-copilot/public/api/session.php',
          {},
          signal,
        );
        if (!session.ok) {
          discardResponse(session);
          throw new TargetFailure('blocked', 'Module session unavailable');
        }
        return this.json(session, signal);
      });
      if (data.chart_open !== true || typeof data.csrf_token !== 'string' || !data.csrf_token)
        throw new TargetFailure('blocked', 'Assigned chart not open');
      this.csrf = data.csrf_token;
      this.version =
        typeof data.module_version === 'string' ? data.module_version.slice(0, 100) : 'unknown';
      const started = await this.timed('target.conversation', 'handshake', async signal => {
        const conversation = await this.request(
          'interface/modules/custom_modules/oe-module-copilot/public/api/conversation.php',
          this.jsonBody({ action: 'start', csrf_token: this.csrf }),
          signal,
        );
        if (!conversation.ok) {
          discardResponse(conversation);
          throw new TargetFailure('blocked', 'Conversation start failed');
        }
        return this.json(conversation, signal);
      });
      if (
        typeof started.conversation_id !== 'string' ||
        !/^[\w-]{1,120}$/.test(started.conversation_id)
      )
        throw new TargetFailure('blocked', 'Invalid conversation');
      this.conversation = started.conversation_id;
      return this.version;
    } catch (e) {
      if (e instanceof TargetFailure) throw e;
      if (e instanceof DeadlineExceeded) throw new TargetFailure('blocked', e.message, e.info);
      throw new TargetFailure('blocked', 'Target handshake failed');
    }
  }
  private async ticket() {
    const data = await this.timed('target.ticket', 'handshake', async signal => {
      const response = await this.request(
        'interface/modules/custom_modules/oe-module-copilot/public/api/ticket.php',
        this.jsonBody({ csrf_token: this.csrf, conversation_id: this.conversation }),
        signal,
      );
      if (!response.ok) {
        discardResponse(response);
        throw new TargetFailure('incomplete', 'Ticket unavailable');
      }
      return this.json(response, signal);
    });
    if (typeof data.token !== 'string' || !data.token)
      throw new TargetFailure('incomplete', 'Invalid ticket');
    this.issuedTickets.push(data.token);
    return data.token;
  }
  async upload(documentType: 'lab_pdf' | 'intake_form', bytes: Buffer) {
    const base = 'interface/modules/custom_modules/oe-module-copilot/public/api/';
    const data = await this.timed('target.upload_intent', 'upload', async signal => {
      const intent = await this.request(
        `${base}document_intent.php`,
        this.jsonBody({ csrf_token: this.csrf, document_type: documentType }),
        signal,
      );
      if (!intent.ok) {
        discardResponse(intent);
        throw new TargetFailure('incomplete', 'Document intent rejected');
      }
      return this.json(intent, signal);
    });
    if (typeof data.intent_id !== 'string' || !/^[a-f0-9]{32}$/.test(data.intent_id))
      throw new TargetFailure('incomplete', 'Invalid document intent');
    const form = new FormData();
    form.set('csrf_token', this.csrf);
    form.set('intent_id', data.intent_id);
    form.set(
      'document',
      new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
      'synthetic.pdf',
    );
    let uploaded: Record<string, unknown>;
    try {
      uploaded = await this.timed('target.upload', 'upload', async signal => {
        const response = await this.request(
          `${base}document_upload.php`,
          { method: 'POST', body: form },
          signal,
        );
        if (response.status !== 200 && response.status !== 201) {
          discardResponse(response);
          throw new TargetFailure('incomplete', 'Document upload rejected');
        }
        return this.json(response, signal);
      });
    } catch (error) {
      if (error instanceof DeadlineExceeded)
        throw new TargetFailure('incomplete', error.message, error.info);
      throw new TargetFailure('incomplete', 'Document upload delivery uncertain');
    }
    const source = uploaded.source;
    // The Co-Pilot's source ids are namespaced as `document:<32 hex>` (a colon),
    // so the accepted charset must allow ':' as well as word chars and '-';
    // otherwise every real PDF upload is rejected here (the attach_pdf channel
    // was non-functional against the live target before this). Still bounded.
    if (
      !source ||
      typeof source !== 'object' ||
      !('source_id' in source) ||
      typeof source.source_id !== 'string' ||
      !/^[\w:-]{1,120}$/.test(source.source_id)
    )
      throw new TargetFailure('incomplete', 'Invalid document source');
    return source.source_id;
  }
  async turn(
    message: string,
    turn: number,
    sourceId?: string,
  ): Promise<{
    observation: Observation;
    attempts: Attempt[];
    timing: { sentAt: string; receivedAt: string };
  }> {
    if (!this.conversation || message.length < 1 || message.length > 1000)
      throw new TargetFailure('incomplete', 'Invalid turn');
    const attempts: Attempt[] = [];
    for (let number = 1; number <= 2; number++) {
      const token = await this.ticket();
      const requestCorrelationId = randomUUID();
      let response: Response;
      let data: Record<string, unknown> | undefined;
      let sentAt: string, receivedAt: string;
      try {
        ({ response, data, sentAt, receivedAt } = await this.timed(
          'target.turn',
          'turn',
          async signal => {
            const sentAt = new Date().toISOString();
            const response = await this.request(
              `copilot-api/v1/conversations/${this.conversation}/turns`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Copilot-Token': token },
                body: JSON.stringify({
                  message,
                  correlation_id: requestCorrelationId,
                  ...(sourceId ? { attachment: { source_id: sourceId } } : {}),
                  stream: false,
                }),
              },
              signal,
            );
            if (!response.ok) {
              discardResponse(response);
              return { response, data: undefined, sentAt, receivedAt: new Date().toISOString() };
            }
            const data = await boundedTurnJson(response, signal);
            return { response, data, sentAt, receivedAt: new Date().toISOString() };
          },
        ));
      } catch (error) {
        if (error instanceof DeadlineExceeded && !error.info.attempted)
          throw new TargetFailure('incomplete', error.message, error.info);
        attempts.push({ number, outcome: 'ambiguous' });
        throw new TurnFailure(
          attempts,
          error instanceof DeadlineExceeded
            ? error.message
            : error instanceof TargetFailure
              ? error.message
              : 'Turn delivery uncertain or rejected',
          error instanceof DeadlineExceeded ? error.info : undefined,
        );
      }
      if (!response.ok) {
        // Only the explicit not-applied contract proves a turn was not accepted.
        const proven =
          response.status === 409 && response.headers.get('X-Copilot-Turn-Not-Applied') === 'true';
        attempts.push({
          number,
          outcome: proven ? 'unprocessed' : 'ambiguous',
          status: response.status,
        });
        if (proven && number === 1) continue;
        throw new TurnFailure(attempts);
      }
      if (!data) {
        attempts.push({ number, outcome: 'ambiguous', status: response.status });
        throw new TurnFailure(attempts, 'Target turn body unavailable');
      }
      const statuses = ['complete', 'partial', 'fallback', 'denied', 'refused', 'failed'] as const;
      if (
        typeof data.turn_id !== 'string' ||
        !data.turn_id ||
        data.conversation_id !== this.conversation ||
        !statuses.some(status => status === data.status) ||
        typeof data.summary !== 'string' ||
        !Array.isArray(data.claims) ||
        !data.claims.every(c => c && typeof c === 'object' && typeof c.text === 'string') ||
        !Array.isArray(data.limitations) ||
        !data.limitations.every(l => l && typeof l === 'object' && typeof l.detail === 'string')
      ) {
        attempts.push({ number, outcome: 'ambiguous', status: response.status });
        throw new TurnFailure(attempts);
      }
      const claims = (data.claims as Record<string, unknown>[]).map(claim => {
        const kind = boundedString(claim.kind) ?? boundedString(claim.type);
        return { text: claim.text as string, kind, sources: claimSources(claim, kind) };
      });
      const limitations = (data.limitations as Record<string, unknown>[]).map(limitation => ({
        detail: limitation.detail as string,
        code: boundedString(limitation.code),
      }));
      const visible = [
        data.summary as string,
        ...claims.map(c => c.text),
        ...limitations.map(l => l.detail),
      ]
        .filter(Boolean)
        .join('\n');
      const truncated = visible.length > MAX_VISIBLE_CHARS;
      const partial = data.status === 'partial';
      let observation: Observation;
      try {
        observation = observationV2.parse({
          v: 2,
          turn,
          ref: `turn-${turn}`,
          status: data.status,
          response: visible.slice(0, MAX_VISIBLE_CHARS),
          target: {
            conversationId: this.conversation,
            turnId: data.turn_id,
            requestCorrelationId,
            responseCorrelationId: boundedString(data.correlation_id),
          },
          attachment: sourceId ? { sourceId } : undefined,
          summary: data.summary,
          claims,
          limitations,
          completeness: {
            state: truncated ? 'truncated' : partial ? 'partial' : 'complete',
            reasons: [
              ...(partial ? (['target_partial'] as const) : []),
              ...(truncated ? (['visible_text_limit'] as const) : []),
            ],
            visibleChars: visible.length,
            retainedChars: Math.min(visible.length, MAX_VISIBLE_CHARS),
          },
        });
      } catch {
        attempts.push({ number, outcome: 'ambiguous', status: response.status });
        throw new TurnFailure(attempts);
      }
      attempts.push({ number, outcome: 'observed', status: response.status });
      return { observation, attempts, timing: { sentAt, receivedAt } };
    }
    throw new TurnFailure(attempts);
  }
  async close() {
    if (this.conversation) {
      // Cleanup is best effort after execution stops, including when its run
      // budget expired. Give it a separate bounded handshake allowance.
      try {
        await withinDeadline('target.close', this.limits.handshake, undefined, signal =>
          this.requestHeaders(
            'interface/modules/custom_modules/oe-module-copilot/public/api/conversation.php',
            this.jsonBody({
              action: 'end',
              csrf_token: this.csrf,
              conversation_id: this.conversation,
            }),
            signal,
          ),
        );
      } catch {
        /* best-effort cleanup; caller records case outcome separately */
      }
    }
    this.cookies.clear();
    this.csrf = '';
    this.conversation = '';
    this.assignedPid = null;
    this.issuedTickets = [];
  }
}

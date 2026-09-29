import type { Observation } from '../../../packages/contracts/src/index.js';
import { createHash } from 'node:crypto';

export type Identity = { username: string; password: string; pubpid: string };
export class TargetFailure extends Error {
  constructor(readonly kind: 'blocked' | 'incomplete', message: string) { super(message); }
}
export type Attempt = { number: number; outcome: 'observed' | 'unprocessed' | 'ambiguous'; status?: number };
export class TurnFailure extends TargetFailure {
  constructor(readonly attempts: Attempt[]) { super('incomplete', 'Turn delivery uncertain or rejected'); }
}

export class Session {
  private cookies = new Map<string, string>();
  private csrf = '';
  private conversation = '';
  private issuedTickets: string[] = [];
  version = 'unknown';
  assignedPid: number | null = null;
  constructor(readonly baseUrl: string, readonly user: Identity, readonly transport: typeof fetch = fetch) {}
  secrets() { return [this.user.password, this.csrf, ...this.cookies.values(), ...this.issuedTickets].filter(Boolean); }
  private url(path: string) { return new URL(path, this.baseUrl.replace(/\/?$/, '/')).toString(); }
  private async request(path: string, init: RequestInit = {}) {
    const response = await this.transport(this.url(path), {
      ...init, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...init.headers }
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const split = pair.indexOf('=');
      if (split > 0) this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  private form(fields: Record<string, string>) { return new URLSearchParams(fields); }
  private jsonBody(fields: Record<string, string>): RequestInit { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }; }
  private async resolvePid(pubpid = this.user.pubpid): Promise<number> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(pubpid)) throw new TargetFailure('blocked', 'Invalid external patient ID');
    // OpenEMR's authenticated patient finder: searchType=true uses LIKE without
    // a suffix; restrict sColumns to pubpid and require the full filtered count.
    const query = new URLSearchParams({ sColumns: 'pubpid', sSearch: pubpid, searchType: 'true', iDisplayStart: '0', iDisplayLength: '2', sEcho: '1' });
    const response = await this.request(`interface/main/finder/dynamic_finder_ajax.php?${query}`);
    if (!response.ok) throw new TargetFailure('blocked', 'External patient ID lookup unavailable');
    let data: Record<string, unknown>;
    try { data = await this.json(response); }
    catch { throw new TargetFailure('blocked', 'External patient ID lookup invalid'); }
    const row = Array.isArray(data.aaData) && data.aaData.length === 1 ? data.aaData[0] : null;
    const count = data.iTotalDisplayRecords;
    if ((count !== 1 && count !== '1') || !row || typeof row !== 'object' || Array.isArray(row) || row.DT_RowId === undefined) {
      // aaData is an array of rows; each row carries DT_RowId and index 0.
      throw new TargetFailure('blocked', 'External patient ID not uniquely resolved');
    }
    const fields = row as Record<string, unknown>;
    const match = typeof fields.DT_RowId === 'string' ? /^pid_([1-9][0-9]*)$/.exec(fields.DT_RowId) : null;
    const pid = match ? Number(match[1]) : NaN;
    if (fields['0'] !== pubpid || !Number.isSafeInteger(pid)) throw new TargetFailure('blocked', 'External patient ID lookup mismatch');
    return pid;
  }
  async cannotAccess(pubpid: string) {
    try { await this.resolvePid(pubpid); return false; }
    catch (e) { if (e instanceof TargetFailure && e.message === 'External patient ID not uniquely resolved') return true; throw e; }
  }
  async chartReportFingerprint(): Promise<string | null> {
    if (this.assignedPid === null) return null;
    try {
      const response = await this.request('interface/patient_file/report/patient_report.php');
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return null;
      if (Number(response.headers.get('content-length') ?? 0) > 2_000_000) return null;
      const html = await response.text();
      if (!html || html.length > 2_000_000 || !/\border(?:s|ing)?\b/i.test(html)) return null;
      return createHash('sha256').update(html).digest('hex');
    } catch { return null; }
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    try { const value: unknown = await response.json(); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; }
    catch { /* malformed target response */ }
    throw new TargetFailure('incomplete', 'Malformed target response');
  }
  async open() {
    try {
      const ready = await this.request('copilot-api/ready');
      if (!ready.ok) throw new TargetFailure('blocked', 'Target not ready');
      const login = await this.request('interface/main/main_screen.php?auth=login&site=default', {
        method: 'POST', body: this.form({ new_login_session_management: '1', languageChoice: '1', authUser: this.user.username, clearPass: this.user.password })
      });
      if (login.status !== 302) throw new TargetFailure('blocked', 'Test user login failed');
      const pid = await this.resolvePid();
      this.assignedPid = pid;
      const chart = await this.request(`interface/patient_file/summary/demographics.php?set_pid=${pid}`);
      if (!chart.ok) throw new TargetFailure('blocked', 'Assigned chart unavailable');
      const session = await this.request('interface/modules/custom_modules/oe-module-copilot/public/api/session.php');
      if (!session.ok) throw new TargetFailure('blocked', 'Module session unavailable');
      const data = await this.json(session);
      if (data.chart_open !== true || typeof data.csrf_token !== 'string' || !data.csrf_token) throw new TargetFailure('blocked', 'Assigned chart not open');
      this.csrf = data.csrf_token;
      this.version = typeof data.module_version === 'string' ? data.module_version.slice(0, 100) : 'unknown';
      const conversation = await this.request('interface/modules/custom_modules/oe-module-copilot/public/api/conversation.php', this.jsonBody({ action: 'start', csrf_token: this.csrf }));
      if (!conversation.ok) throw new TargetFailure('blocked', 'Conversation start failed');
      const started = await this.json(conversation);
      if (typeof started.conversation_id !== 'string' || !/^[\w-]{1,120}$/.test(started.conversation_id)) throw new TargetFailure('blocked', 'Invalid conversation');
      this.conversation = started.conversation_id;
      return this.version;
    } catch (e) { if (e instanceof TargetFailure) throw e; throw new TargetFailure('blocked', 'Target handshake failed'); }
  }
  private async ticket() {
    const response = await this.request('interface/modules/custom_modules/oe-module-copilot/public/api/ticket.php', this.jsonBody({ csrf_token: this.csrf, conversation_id: this.conversation }));
    if (!response.ok) throw new TargetFailure('incomplete', 'Ticket unavailable');
    const data = await this.json(response);
    if (typeof data.token !== 'string' || !data.token) throw new TargetFailure('incomplete', 'Invalid ticket');
    this.issuedTickets.push(data.token);
    return data.token;
  }
  async upload(documentType: 'lab_pdf' | 'intake_form', bytes: Buffer) {
    const base = 'interface/modules/custom_modules/oe-module-copilot/public/api/';
    const intent = await this.request(`${base}document_intent.php`, this.jsonBody({ csrf_token: this.csrf, document_type: documentType }));
    if (!intent.ok) throw new TargetFailure('incomplete', 'Document intent rejected');
    const data = await this.json(intent);
    if (typeof data.intent_id !== 'string' || !/^[a-f0-9]{32}$/.test(data.intent_id)) throw new TargetFailure('incomplete', 'Invalid document intent');
    const form = new FormData(); form.set('csrf_token', this.csrf); form.set('intent_id', data.intent_id);
    form.set('document', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'synthetic.pdf');
    let response: Response;
    try { response = await this.request(`${base}document_upload.php`, { method: 'POST', body: form }); }
    catch { throw new TargetFailure('incomplete', 'Document upload delivery uncertain'); }
    if (response.status !== 200 && response.status !== 201) throw new TargetFailure('incomplete', 'Document upload rejected');
    const uploaded = await this.json(response);
    const source = uploaded.source;
    if (!source || typeof source !== 'object' || !('source_id' in source) || typeof source.source_id !== 'string' || !/^[\w-]{1,120}$/.test(source.source_id)) throw new TargetFailure('incomplete', 'Invalid document source');
    return source.source_id;
  }
  async turn(message: string, turn: number, sourceId?: string): Promise<{ observation: Observation; attempts: Attempt[] }> {
    if (!this.conversation || message.length < 1 || message.length > 1000) throw new TargetFailure('incomplete', 'Invalid turn');
    const attempts: Attempt[] = [];
    for (let number = 1; number <= 2; number++) {
      const token = await this.ticket();
      let response: Response;
      try {
        response = await this.request(`copilot-api/v1/conversations/${this.conversation}/turns`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Copilot-Token': token },
          body: JSON.stringify({ message, ...(sourceId ? { attachment: { source_id: sourceId } } : {}), stream: false })
        });
      } catch { attempts.push({ number, outcome: 'ambiguous' }); throw new TurnFailure(attempts); }
      if (!response.ok) {
        // Only the explicit not-applied contract proves a turn was not accepted.
        const proven = response.status === 409 && response.headers.get('X-Copilot-Turn-Not-Applied') === 'true';
        attempts.push({ number, outcome: proven ? 'unprocessed' : 'ambiguous', status: response.status });
        if (proven && number === 1) continue;
        throw new TurnFailure(attempts);
      }
      const data = await this.json(response);
      const statuses = ['complete', 'partial', 'fallback', 'denied', 'refused', 'failed'] as const;
      if (typeof data.turn_id !== 'string' || !data.turn_id || data.conversation_id !== this.conversation || !statuses.some(status => status === data.status) || typeof data.summary !== 'string' || !Array.isArray(data.claims) || !data.claims.every(c => c && typeof c === 'object' && typeof c.text === 'string') || !Array.isArray(data.limitations) || !data.limitations.every(l => l && typeof l === 'object' && typeof l.detail === 'string')) {
        attempts.push({ number, outcome: 'ambiguous', status: response.status });
        throw new TurnFailure(attempts);
      }
      const visible = [data.summary, ...data.claims.map(c => c.text as string), ...data.limitations.map(l => l.detail as string)].filter(Boolean).join('\n');
      attempts.push({ number, outcome: 'observed', status: response.status });
      return { observation: { v: 1, turn, ref: `turn-${turn}`, status: data.status as (typeof statuses)[number], response: visible.slice(0, 10000) }, attempts };
    }
    throw new TurnFailure(attempts);
  }
  async close() {
    if (this.conversation) {
      try { await this.request('interface/modules/custom_modules/oe-module-copilot/public/api/conversation.php', this.jsonBody({ action: 'end', csrf_token: this.csrf, conversation_id: this.conversation })); }
      catch { /* best-effort cleanup; caller records case outcome separately */ }
    }
    this.cookies.clear(); this.csrf = ''; this.conversation = ''; this.assignedPid = null; this.issuedTickets = [];
  }
}

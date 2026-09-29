import {
  evidenceCollectRequest, evidenceConfig, evidenceResponse, MAX_EVIDENCE_BYTES, MAX_EVIDENCE_DEADLINE_MS,
  type EvidenceCollectRequest, type EvidenceConfig, type EvidenceProfile, type EvidenceResponseV1
} from '../../../../packages/contracts/src/evidence-provider.js';
import { boundedLimit, DeadlineExceeded, discardResponse, readBodyText, withinDeadline, type DeadlineInfo } from '../deadlines.js';

export type EvidenceUnavailableReason = 'invalid_request' | 'config_mismatch' | 'auth_unavailable' | 'aborted' |
  'timeout' | 'transport_unavailable' | 'redirect' | 'bad_media_type' | 'oversize' | 'malformed' |
  'binding_mismatch' | 'stale' | 'secret_reflection';
export type EvidenceCollectResult =
  | { v: 1; status: 'available'; evidence: EvidenceResponseV1 }
  | { v: 1; status: 'unavailable'; reason: EvidenceUnavailableReason; deadline?: DeadlineInfo };
export interface EvidenceProvider {
  collect(request: EvidenceCollectRequest, options: { signal: AbortSignal; runUntil?: number }): Promise<EvidenceCollectResult>;
}
type Dependencies = { fetch: typeof fetch; resolveSecret?: (ref: 'evidence-http-token') => string | undefined; now?: () => number };
class ProviderFailure extends Error { constructor(readonly reason: EvidenceUnavailableReason) { super(reason); } }
const unavailable = (reason: EvidenceUnavailableReason, deadline?: DeadlineInfo): EvidenceCollectResult =>
  ({ v: 1, status: 'unavailable', reason, ...(deadline ? { deadline } : {}) });
const available = (evidence: EvidenceResponseV1): EvidenceCollectResult => ({ v: 1, status: 'available', evidence });

export function resolveEvidenceSecret(ref: 'evidence-http-token'): string | undefined {
  return ref === 'evidence-http-token' ? process.env.EVIDENCE_HTTP_AUTH_TOKEN : undefined;
}
export function loadEvidenceConfig(env: NodeJS.ProcessEnv = process.env): EvidenceConfig {
  if (!env.EVIDENCE_PROVIDER_CONFIG) return { mode: 'off' };
  try { return evidenceConfig.parse(JSON.parse(env.EVIDENCE_PROVIDER_CONFIG)); }
  catch { throw new Error('Invalid evidence provider configuration'); }
}
function validToken(value: string | undefined): value is string {
  return !!value && value.length >= 16 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}
function reflected(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value)) return value.some(item => reflected(item, token));
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => key.includes(token) || reflected(item, token));
  return false;
}
function bindingMatches(request: EvidenceCollectRequest, response: EvidenceResponseV1): boolean {
  const keys = ['targetId', 'targetVersion', 'selectedChartId', 'comparisonChartId', 'conversationId', 'turnId', 'requestCorrelationId', 'responseCorrelationId'] as const;
  return keys.every(key => response.binding[key] === request[key]);
}
function admitResponse(request: EvidenceCollectRequest, response: EvidenceResponseV1, profile?: EvidenceProfile, now = Date.now()): EvidenceCollectResult {
  if (response.profileId !== request.profileId || response.sourceVersion !== request.sourceVersion || !bindingMatches(request, response)) return unavailable('binding_mismatch');
  if (profile && (Date.parse(response.collectedAt) < now - profile.maxAgeMs || Date.parse(response.collectedAt) > now + profile.maxSkewMs ||
    Date.parse(response.collectedAt) < Date.parse(request.receivedAt) - profile.maxSkewMs)) return unavailable('stale');
  if (profile && (response.facts.length > 0 && !profile.capabilities.includes('seeded_facts') ||
    (response.auditEvents.length > 0 || response.coverage.length > 0) && !profile.capabilities.includes('audit_events'))) return unavailable('binding_mismatch');
  const allowed = new Set([request.selectedChartId, request.comparisonChartId].filter((id): id is number => id !== undefined));
  if (response.facts.some(fact => !allowed.has(fact.chartId)) || response.auditEvents.some(event => !allowed.has(event.chartId))) return unavailable('binding_mismatch');
  return available(response);
}

/** Config is operator-owned. The default is off, and construction never sends a request. */
export function createEvidenceProvider(config: EvidenceConfig | undefined, deps: Dependencies): EvidenceProvider | null {
  const parsedResult = evidenceConfig.safeParse(config ?? { mode: 'off' });
  if (!parsedResult.success) throw new Error('Invalid evidence provider configuration');
  const parsed = parsedResult.data;
  if (parsed.mode === 'off') return null;
  const profile = parsed.profile;
  const endpoint = `${profile.origin}${profile.path}`;
  const now = deps.now ?? Date.now;
  const resolveSecret = deps.resolveSecret ?? resolveEvidenceSecret;
  return {
    async collect(input, options) {
      const request = evidenceCollectRequest.safeParse(input);
      if (!request.success) return unavailable('invalid_request');
      if (!options?.signal || typeof options.signal.aborted !== 'boolean' ||
        options.runUntil !== undefined && (!Number.isSafeInteger(options.runUntil) || options.runUntil < 0)) return unavailable('invalid_request');
      const value = request.data;
      if (value.profileId !== profile.id || value.sourceVersion !== profile.sourceVersion || value.targetId !== profile.targetId || value.targetVersion !== profile.targetVersion) return unavailable('config_mismatch');
      if (options.signal.aborted) return unavailable('aborted');
      if (Date.parse(value.receivedAt) < now() - profile.maxAgeMs || Date.parse(value.receivedAt) > now() + profile.maxSkewMs) return unavailable('stale');
      let token: string | undefined;
      try { token = resolveSecret(profile.authRef); } catch { return unavailable('auth_unavailable'); }
      if (!validToken(token)) return unavailable('auth_unavailable');
      // A single fixed ASCII header carries the entire validated request.
      // No provider-controlled endpoint, query, body, or additional header exists.
      const requestHeader = Buffer.from(JSON.stringify(value)).toString('base64url');
      if (requestHeader.length > 4096) return unavailable('invalid_request');
      try {
        return await withinDeadline('evidence.collect', boundedLimit(profile.deadlineMs, MAX_EVIDENCE_DEADLINE_MS), options.runUntil, async timedSignal => {
          const signal = AbortSignal.any([timedSignal, options.signal]);
          if (signal.aborted) throw new ProviderFailure('aborted');
          const response = await deps.fetch(endpoint, {
            method: 'GET', redirect: 'manual', signal, headers: {
              Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Auditor-Evidence-Request-V1': requestHeader
            }
          });
          if (signal.aborted) { discardResponse(response); throw new ProviderFailure('aborted'); }
          if (response.url && response.url !== endpoint || response.status >= 300 && response.status < 400) { discardResponse(response); throw new ProviderFailure('redirect'); }
          if (!response.ok) { discardResponse(response); throw new ProviderFailure('transport_unavailable'); }
          if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) { discardResponse(response); throw new ProviderFailure('bad_media_type'); }
          const length = response.headers.get('content-length');
          if (length && (!/^\d+$/.test(length) || Number(length) > MAX_EVIDENCE_BYTES)) { discardResponse(response); throw new ProviderFailure(/^\d+$/.test(length) ? 'oversize' : 'malformed'); }
          let body: string;
          try { body = await readBodyText(response, signal, MAX_EVIDENCE_BYTES); }
          catch (error) { throw new ProviderFailure(error instanceof Error && error.message === 'Response body exceeded limit' ? 'oversize' : 'malformed'); }
          if (body.includes(token)) throw new ProviderFailure('secret_reflection');
          let raw: unknown;
          try { raw = JSON.parse(body); } catch { throw new ProviderFailure('malformed'); }
          if (reflected(raw, token)) throw new ProviderFailure('secret_reflection');
          const validated = evidenceResponse.safeParse(raw);
          if (!validated.success) throw new ProviderFailure('malformed');
          return admitResponse(value, validated.data, profile, now());
        });
      } catch (error) {
        if (error instanceof DeadlineExceeded) return unavailable('timeout', error.info);
        if (options.signal.aborted) return unavailable('aborted');
        return unavailable(error instanceof ProviderFailure ? error.reason : 'transport_unavailable');
      }
    }
  };
}

/** Deterministic test provider; it has no network, auth, persistence, or worker hook. */
export function createFixtureEvidenceProvider(script: ReadonlyMap<string, EvidenceResponseV1>): EvidenceProvider {
  return { async collect(input, options) {
    const request = evidenceCollectRequest.safeParse(input);
    if (!request.success) return unavailable('invalid_request');
    if (!options?.signal || typeof options.signal.aborted !== 'boolean') return unavailable('invalid_request');
    if (options.signal.aborted) return unavailable('aborted');
    const response = script.get(request.data.requestCorrelationId);
    if (!response) return unavailable('transport_unavailable');
    const parsed = evidenceResponse.safeParse(response);
    return parsed.success ? admitResponse(request.data, parsed.data) : unavailable('malformed');
  } };
}

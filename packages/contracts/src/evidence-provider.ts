import { z } from 'zod';

export const MAX_EVIDENCE_BYTES = 65_536;
export const MAX_EVIDENCE_DEADLINE_MS = 15_000;
const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/);
const knownVersion = id.refine(value => value !== 'unknown', 'Verified version required');
const text = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const chartId = z.number().int().positive();
const instant = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/).refine(value => {
  try { return new Date(value).toISOString() === value; } catch { return false; }
}, 'Exact UTC millisecond timestamp required');
const unique = (values: string[]) => new Set(values).size === values.length;
const timeWindow = z.object({ start: instant, end: instant }).strict().refine(value => value.start <= value.end, 'Invalid time window');

const origin = z.url().refine(value => {
  try {
    const url = new URL(value);
    return value === url.origin && !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}, 'Exact HTTPS origin or loopback HTTP origin required');
const path = z.string().min(2).max(200).regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/)
  .refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..'), 'Fixed path required');
export const evidenceProfile = z.object({
  id, targetId: z.uuid(), targetVersion: knownVersion, origin, path, sourceVersion: knownVersion,
  capabilities: z.array(z.enum(['seeded_facts', 'audit_events'])).min(1).max(2).refine(unique, 'Duplicate capability'),
  maxAgeMs: z.number().int().min(1).max(300_000), maxSkewMs: z.number().int().min(0).max(30_000),
  deadlineMs: z.number().int().min(1).max(MAX_EVIDENCE_DEADLINE_MS), authRef: z.literal('evidence-http-token')
}).strict();
export const evidenceConfig = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }).strict(),
  z.object({ mode: z.literal('http'), profile: evidenceProfile }).strict()
]);

const binding = z.object({
  targetId: z.uuid(), targetVersion: knownVersion, selectedChartId: chartId, comparisonChartId: chartId.optional(),
  conversationId: id, turnId: id, requestCorrelationId: id, responseCorrelationId: id.optional()
}).strict();
export const evidenceCollectRequest = binding.extend({
  v: z.literal(1), profileId: id, sourceVersion: knownVersion, runId: z.uuid(), leaseGeneration: z.number().int().positive(),
  attemptId: id, caseId: z.uuid(), executionCaseId: z.uuid().optional(), turnOrdinal: z.number().int().min(1).max(3),
  selectedUser: z.enum(['A', 'B']), sentAt: instant, receivedAt: instant, window: timeWindow
}).strict().refine(value => value.window.start <= value.sentAt && value.sentAt <= value.receivedAt && value.receivedAt <= value.window.end, 'Turn outside collection window')
  .refine(value => value.comparisonChartId === undefined || value.comparisonChartId !== value.selectedChartId, 'Comparison chart must differ');

const fact = z.object({ factId: id, chartId, sourceRecordRef: id, value: text }).strict();
const auditEvent = z.object({
  eventId: id, actorClass: z.enum(['assistant', 'clinician', 'system', 'unknown']),
  operationClass: z.enum(['read', 'write']), chartId, occurredAt: instant,
  conversationId: id.optional(), turnId: id.optional(), requestCorrelationId: id.optional()
}).strict();
const coverage = z.object({
  operationClasses: z.array(z.enum(['read', 'write'])).min(1).max(2).refine(unique, 'Duplicate operation class'),
  state: z.enum(['complete', 'partial', 'unknown']), attestedComplete: z.boolean(),
  window: timeWindow, continuity: id.optional()
}).strict();
export const evidenceResponse = z.object({
  v: z.literal(1), profileId: id, sourceVersion: id, collectedAt: instant, binding,
  facts: z.array(fact).max(16), auditEvents: z.array(auditEvent).max(32), coverage: z.array(coverage).max(8)
}).strict().superRefine((value, ctx) => {
  if (!unique(value.facts.map(row => row.factId))) ctx.addIssue({ code: 'custom', message: 'Duplicate fact ID' });
  if (!unique(value.auditEvents.map(row => row.eventId))) ctx.addIssue({ code: 'custom', message: 'Duplicate event ID' });
});

export type EvidenceConfig = z.infer<typeof evidenceConfig>;
export type EvidenceProfile = z.infer<typeof evidenceProfile>;
export type EvidenceCollectRequest = z.infer<typeof evidenceCollectRequest>;
export type EvidenceResponseV1 = z.infer<typeof evidenceResponse>;

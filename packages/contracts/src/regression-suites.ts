import { z } from 'zod';
import { selectedRoles, startInput } from './index.js';
import { replaySignal } from './regressions.js';

// G02 bounded regression suites (not re-exported from index.ts: this file reads index.ts).
// A suite replays regression identities against ONE target through the ordinary target reservation, one run at a time.
// Bounds: at most 25 identities, one Judge role, an optional paid-call cap that applies to each item run (the ledger is per run,
// so a suite can never spend more than its item count times that cap), and a wall-clock budget after which nothing new starts.
// It never deploys or patches a target and never re-runs an item whose run was blocked, incomplete or lost.
const timestamp = z.iso.datetime({ offset: true });
type Bounded = { roles: z.infer<typeof selectedRoles>; ollamaUrl?: string; openRouterCapUsd?: number };
const bounded = (input: Bounded, ctx: z.RefinementCtx) => {
  if (input.roles.judge.provider === 'openrouter' && input.openRouterCapUsd === undefined) ctx.addIssue({ code: 'custom', message: 'A paid-call cap is required' });
  if (input.roles.judge.provider === 'ollama' && !input.ollamaUrl) ctx.addIssue({ code: 'custom', message: 'An Ollama URL is required for a local Judge' });
};
const settingsShape = {
  roles: selectedRoles, ollamaUrl: startInput.shape.ollamaUrl, openRouterCapUsd: startInput.shape.openRouterCapUsd,
  maxItems: z.number().int().min(1).max(25).default(25), maxMinutes: z.number().int().min(1).max(240).default(60)
};
export const suiteSettings = z.object(settingsShape).strict().superRefine(bounded);
export const suiteSelection = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('identities'), identityIds: z.array(z.uuid()).min(1).max(25) }).strict(),
  z.object({ mode: z.literal('all_confirmed') }).strict() // every identity with a source finding or a replay on the target
]);
export const suiteLaunch = z.object({ ...settingsShape, targetId: z.uuid(), selection: suiteSelection, expectedVersion: z.string().trim().min(1).max(200).optional() }).strict().superRefine((input, ctx) => {
  bounded(input, ctx);
  if (input.selection.mode === 'identities' && (new Set(input.selection.identityIds).size !== input.selection.identityIds.length || input.selection.identityIds.length > input.maxItems)) ctx.addIssue({ code: 'custom', message: 'Identities must be distinct and fit the item bound' });
});
export const versionTriggerInput = z.discriminatedUnion('enabled', [z.object({ enabled: z.literal(true), settings: suiteSettings }).strict(), z.object({ enabled: z.literal(false) }).strict()]);

export const suiteItem = z.object({
  ordinal: z.number().int().positive(), identityId: z.uuid(), title: z.string().nullable(), category: z.string().nullable(), regressionId: z.uuid(), replayCaseId: z.uuid().nullable(),
  state: z.enum(['pending', 'running', 'finished', 'skipped']), runId: z.uuid().nullable(), outcome: z.string().nullable(), targetVersion: z.string().nullable(),
  signal: replaySignal.nullable(), versionCheck: z.enum(['not_requested', 'matches', 'differs', 'unverified']).nullable(), reason: z.string().nullable(),
  startedAt: timestamp.nullable(), finishedAt: timestamp.nullable()
}).strict();
export const suiteSummary = z.object({
  id: z.uuid(), targetId: z.uuid(), targetName: z.string().nullable(), trigger: z.enum(['manual', 'version_change']), expectedVersion: z.string().nullable(),
  state: z.enum(['active', 'completed', 'stopped']), createdAt: timestamp, finishedAt: timestamp.nullable(), maxMinutes: z.number().int().positive(), omittedCount: z.number().int().nonnegative(),
  counts: z.object({ pending: z.number().int(), running: z.number().int(), finished: z.number().int(), skipped: z.number().int() }).strict(), outcomes: z.record(z.string(), z.number().int())
}).strict();
export const suiteDetail = suiteSummary.extend({ v: z.literal(1), settings: suiteSettings, items: z.array(suiteItem).max(25) }).strict();
export const suiteList = z.object({ v: z.literal(1), items: z.array(suiteSummary), nextCursor: z.string().nullable() }).strict();
export const suiteQuery = z.object({
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(25), cursor: z.string().regex(/^[0-9]{1,18}$/).optional(), targetId: z.uuid().optional()
}).strict();
export const versionTrigger = z.object({
  targetId: z.uuid(), targetName: z.string(), enabled: z.boolean(), settings: suiteSettings.nullable(), lastSeenVersion: z.string().nullable(), lastTriggeredVersion: z.string().nullable(), updatedAt: timestamp.nullable()
}).strict();
export type SuiteSettings = z.infer<typeof suiteSettings>;
export type SuiteLaunch = z.infer<typeof suiteLaunch>;
export type SuiteDetail = z.infer<typeof suiteDetail>;
export type SuiteList = z.infer<typeof suiteList>;
export type SuiteQuery = z.infer<typeof suiteQuery>;
export type VersionTrigger = z.infer<typeof versionTrigger>;

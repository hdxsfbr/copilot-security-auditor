import { z } from 'zod';

// G02 regression state, derived per identity, per target and per observed target version from the recorded evidence
// (source findings and finished replays). Rules and their exact definitions: apps/api/src/regression-states.ts.
// `fixed` is the only state that ever says the attack stopped working, and it needs a finished `safe` replay on a verified
// version different from every version that showed the violation, after a violation. Blocked, incomplete, inconclusive,
// version-less and missing results are always `unknown`.
export const regressionState = z.enum(['recurring', 'fixed', 'resurfaced', 'unknown']);
export const regressionStateReason = z.enum([
  'violation_observed_again', 'violation_after_fix', 'safe_on_later_version',
  'not_replayed_since_finding', 'result_not_conclusive', 'version_not_verified', 'violation_version_unverified', 'violation_seen_on_this_version', 'no_prior_violation'
]);
const timestamp = z.iso.datetime({ offset: true });
export const regressionStateEntry = z.object({
  state: regressionState, reason: regressionStateReason, targetVersion: z.string().nullable(),
  basis: z.enum(['source_finding', 'replay']), runId: z.uuid(), observedAt: timestamp
}).strict();
// `current` is the state of the newest observation on this target; `scopes` holds one entry per observed version, newest first.
export const targetRegressionState = z.object({
  targetId: z.uuid(), targetName: z.string().nullable(), current: regressionStateEntry, scopes: z.array(regressionStateEntry).min(1).max(20), pendingReplays: z.number().int().nonnegative()
}).strict();
export type RegressionState = z.infer<typeof regressionState>;
export type RegressionStateReason = z.infer<typeof regressionStateReason>;
export type RegressionStateEntry = z.infer<typeof regressionStateEntry>;
export type TargetRegressionState = z.infer<typeof targetRegressionState>;

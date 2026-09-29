import type { RegressionStateEntry, TargetRegressionState } from '../../../packages/contracts/src/regression-states.js';

// G02 regression state v1: recurring, fixed, resurfaced or unknown for one identity on one target at one observed version.
// Pure and deterministic; it only reads recorded observations and never guesses a version, an order or a fix.
//
// Observations, per identity and target, ordered by when they were observed (source runs and replays by finish time):
//   violation     a confirmed source finding, or a finished replay whose outcome flagged the attack (pending_review / auto_confirm)
//   safe          a finished replay whose outcome was `safe`
//   inconclusive  any other finished replay (inconclusive, blocked, incomplete, ...)
//   pending       a replay still queued or running; it is counted, never interpreted
// Versions are opaque labels a run observed; "later" means observed later, never numerically greater. A version of null was
// never verified. One entry is produced per observed version, from the newest observation at that version:
//   fixed        a safe observation at a verified version that no violation was ever observed at, after a violation observed at
//                a different verified version. A safe replay on the same version that violated is not a fix (the attack may
//                be nondeterministic); a safe replay with no earlier violation on this target has nothing to confirm fixed.
//   resurfaced   a violation observed after some fixed observation on this target (until a newer fix supersedes it)
//   recurring    a violation observed again: a replay that flagged it, or a further finding, with no earlier fix
//   unknown      everything else: inconclusive/blocked/incomplete results, a safe result on an unverified version, and a
//                finding that has not been replayed since (a single observation is not "again")
// Missing evidence therefore never produces `fixed`. Only the newest 2000 replays per identity are considered, which can
// only turn a fixed or resurfaced state into unknown or recurring, never the reverse.
export type StateObservation = { targetId: string; targetName: string | null; version: string | null; kind: 'violation' | 'safe' | 'inconclusive' | 'pending'; basis: 'source_finding' | 'replay'; runId: string; at: string };

const order = (a: StateObservation, b: StateObservation) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.basis === b.basis ? a.runId.localeCompare(b.runId) : a.basis === 'source_finding' ? -1 : 1;

function scopes(observations: StateObservation[]): RegressionStateEntry[] {
  const seen = observations.filter(item => item.kind !== 'pending').sort(order);
  const violated = new Set(seen.filter(item => item.kind === 'violation' && item.version !== null).map(item => item.version));
  const fixed: StateObservation[] = [], latest = new Map<string, RegressionStateEntry>();
  seen.forEach((item, index) => {
    const before = seen.slice(0, index).filter(prior => prior.kind === 'violation');
    let entry: Pick<RegressionStateEntry, 'state' | 'reason'>;
    if (item.kind === 'inconclusive') entry = { state: 'unknown', reason: 'result_not_conclusive' };
    else if (item.kind === 'violation') entry = fixed.length ? { state: 'resurfaced', reason: 'violation_after_fix' }
      : before.length || item.basis === 'replay' ? { state: 'recurring', reason: 'violation_observed_again' } : { state: 'unknown', reason: 'not_replayed_since_finding' };
    else if (item.version === null) entry = { state: 'unknown', reason: 'version_not_verified' };
    else if (violated.has(item.version)) entry = { state: 'unknown', reason: 'violation_seen_on_this_version' };
    else if (!before.length) entry = { state: 'unknown', reason: 'no_prior_violation' };
    else if (!before.some(prior => prior.version !== null)) entry = { state: 'unknown', reason: 'violation_version_unverified' };
    else { entry = { state: 'fixed', reason: 'safe_on_later_version' }; fixed.push(item); }
    latest.set(item.version ?? '', { ...entry, targetVersion: item.version, basis: item.basis, runId: item.runId, observedAt: new Date(item.at).toISOString() });
  });
  return [...latest.values()].sort((a, b) => a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0);
}

export function deriveTargetStates(observations: StateObservation[], scopeLimit = 20, targetLimit = 10): TargetRegressionState[] {
  const byTarget = new Map<string, StateObservation[]>();
  for (const item of observations) byTarget.set(item.targetId, [...byTarget.get(item.targetId) ?? [], item]);
  return [...byTarget.entries()].flatMap(([targetId, items]) => {
    const entries = scopes(items);
    return entries.length ? [{ targetId, targetName: items.find(item => item.targetName)?.targetName ?? null, current: entries[0], scopes: entries.slice(0, scopeLimit), pendingReplays: items.filter(item => item.kind === 'pending').length }] : [];
  }).sort((a, b) => a.current.observedAt < b.current.observedAt ? 1 : -1).slice(0, targetLimit);
}

import { regressionIdentityDetail, regressionIdentityList, type RegressionIdentityDetail, type RegressionIdentityList } from '../../../../../packages/contracts/src/regressions.js';
import type { RegressionState, RegressionStateReason } from '../../../../../packages/contracts/src/regression-states.js';
import { suiteDetail, suiteList, versionTrigger, type SuiteDetail, type SuiteList, type VersionTrigger } from '../../../../../packages/contracts/src/regression-suites.js';
import { localAssignment, type Assignment } from '../models/definitions.js';

const guard = <T,>(schema: { safeParse(value: unknown): { success: boolean } }) => (value: unknown): value is T => schema.safeParse(value).success;
export const isIdentityList = guard<RegressionIdentityList>(regressionIdentityList);
export const isIdentityDetail = guard<RegressionIdentityDetail>(regressionIdentityDetail);
export const isSuiteList = guard<SuiteList>(suiteList);
export const isSuiteDetail = guard<SuiteDetail>(suiteDetail);
export const isTrigger = guard<VersionTrigger>(versionTrigger);
export const isTriggers = (value: unknown): value is VersionTrigger[] => Array.isArray(value) && value.every(isTrigger);

// Text and a glyph always accompany the color, and `unknown` is never worded as a fix.
export const stateInfo: Record<RegressionState, { glyph: string; label: string }> = {
  recurring: { glyph: '▲', label: 'Recurring' }, fixed: { glyph: '✓', label: 'Fixed' }, resurfaced: { glyph: '↺', label: 'Resurfaced' }, unknown: { glyph: '?', label: 'Unknown' }
};
export const reasonText: Record<RegressionStateReason, string> = {
  violation_observed_again: 'Violation observed again', violation_after_fix: 'Violation observed after an earlier fix', safe_on_later_version: 'Safe replay on a later verified version',
  not_replayed_since_finding: 'Not replayed since the finding', result_not_conclusive: 'Latest replay was inconclusive, blocked or incomplete', version_not_verified: 'Safe replay, but no verified version',
  violation_version_unverified: 'The earlier violation has no verified version', violation_seen_on_this_version: 'A violation was also observed on this version', no_prior_violation: 'No earlier violation on this target to confirm fixed'
};
export const words = (value: string) => value.replaceAll('_', ' ');
export const when = (iso: string) => new Date(iso).toLocaleString();
export const signalText = (signal: string | null) => signal === 'unknown' ? 'unknown, not a fix' : signal ? words(signal) : '';
export const versionText = (version: string | null) => version ?? 'version not verified';

// One form shared by the composer's suite mode and the version-change trigger: the Judge, its provider bounds and the suite bounds.
export type SuiteForm = { judge: Assignment; ollamaUrl: string; cap: string; maxItems: number; maxMinutes: number };
export const newSuiteForm = (model: string, ollamaUrl: string): SuiteForm => ({ judge: localAssignment(model), ollamaUrl, cap: '0.25', maxItems: 25, maxMinutes: 60 });
export const suiteSettings = (form: SuiteForm) => ({ roles: { judge: form.judge }, ...(form.judge.provider === 'ollama' ? { ollamaUrl: form.ollamaUrl } : { openRouterCapUsd: Number(form.cap) }), maxItems: form.maxItems, maxMinutes: form.maxMinutes });

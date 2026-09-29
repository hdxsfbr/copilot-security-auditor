import { runDefinition, type RunDefinition } from '../../../../../packages/contracts/src/index.js';
import { isRecord } from '../../api/client.js';

export type Provider = 'ollama' | 'openrouter';
export type Role = 'orchestrator' | 'redTeam' | 'judge';
export type Assignment = { provider: Provider; model: string; maxOutputTokens: number };
export type Draft = {
  name: string; targetId: string; kind: 'selected' | 'adaptive'; caseId: string; caseIds: string[];
  roles: Record<Role, Assignment>; maxCases: number; maxMinutes: number; ollamaUrl: string; cap: string;
};
export type Definition = { id: string; name: string; run: RunDefinition; revision: number; archived: boolean };
export type DefinitionSummary = Pick<Definition, 'id' | 'name' | 'revision'>;
type Availability = 'available' | 'unavailable' | 'not_configured';
export type Catalog = { openrouter: string[]; ollama: string[]; configured: boolean; availability: { openrouter: Availability; ollama: Availability } };
type Status = 'not_required' | 'available' | 'unavailable';
export type Preflight = {
  status: 'available' | 'unavailable'; issues: { code: string; role?: Role }[]; local: { status: Status; installed: string[] }; paid: { status: Status; configured: boolean };
  preview: { reservationNanos: string; capNanos: string | null; attempts: number } | null;
};
type Seed = { id: string; category?: string };

export const allRoles: Role[] = ['orchestrator', 'redTeam', 'judge'];
// Selected runs invoke only the Judge; adaptive runs invoke all three. Documentation is inactive.
export const activeRoles = (kind: Draft['kind']): Role[] => kind === 'selected' ? ['judge'] : allRoles;
export const roleLabel = (role: Role) => role === 'redTeam' ? 'Red Team' : role[0].toUpperCase() + role.slice(1);
export const localAssignment = (model = ''): Assignment => ({ provider: 'ollama', model, maxOutputTokens: 1024 });
export const newDraft = (targetId: string, caseId: string, model: string, ollamaUrl: string): Draft => ({
  name: '', targetId, kind: 'selected', caseId, caseIds: [], maxCases: 3, maxMinutes: 3, ollamaUrl, cap: '0.25',
  roles: { orchestrator: localAssignment(model), redTeam: localAssignment(model), judge: localAssignment(model) },
});
export const seedCategory = (seed: { category?: string }) => seed.category ?? 'prompt_injection';

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const nanosText = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
const availability = (value: unknown) => value === 'available' || value === 'unavailable' || value === 'not_configured';
const requirement = (value: unknown) => value === 'not_required' || value === 'available' || value === 'unavailable';
export const isCatalog = (value: unknown): value is Catalog => isRecord(value) && strings(value.openrouter) && strings(value.ollama) && typeof value.configured === 'boolean'
  && isRecord(value.availability) && availability(value.availability.openrouter) && availability(value.availability.ollama);
export const isSummaryList = (value: unknown): value is DefinitionSummary[] => Array.isArray(value)
  && value.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && Number.isInteger(item.revision));
export const isDefinition = (value: unknown): value is Definition => isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
  && Number.isInteger(value.revision) && Number(value.revision) > 0 && typeof value.archived === 'boolean' && runDefinition.safeParse(value.run).success;
export const isPreflight = (value: unknown): value is Preflight => isRecord(value) && (value.status === 'available' || value.status === 'unavailable')
  && Array.isArray(value.issues) && value.issues.every(issue => isRecord(issue) && typeof issue.code === 'string' && (issue.role === undefined || allRoles.includes(issue.role as Role)))
  && isRecord(value.local) && requirement(value.local.status) && strings(value.local.installed) && isRecord(value.paid) && requirement(value.paid.status) && typeof value.paid.configured === 'boolean'
  && (value.preview === null || (isRecord(value.preview) && nanosText(value.preview.reservationNanos) && (value.preview.capNanos === null || nanosText(value.preview.capNanos)) && Number.isInteger(value.preview.attempts)));
export const isStarted = (value: unknown): value is { id: string } => isRecord(value) && typeof value.id === 'string';

/** Draft -> exact API run definition. Only invoked roles are sent, so an all-paid run needs no Ollama URL. */
export function buildRun(draft: Draft, cases: Seed[]): RunDefinition {
  const active = activeRoles(draft.kind), local = active.some(role => draft.roles[role].provider === 'ollama'), paid = active.some(role => draft.roles[role].provider === 'openrouter');
  const roles = Object.fromEntries(active.map(role => [role, draft.roles[role]]));
  const shared = { targetId: draft.targetId, roles, ...(local ? { ollamaUrl: draft.ollamaUrl } : {}), ...(paid ? { openRouterCapUsd: Number(draft.cap) } : {}) };
  let raw: unknown;
  if (draft.kind === 'selected') raw = { kind: 'selected', input: { ...shared, caseId: draft.caseId } };
  else {
    if (!draft.caseIds.length || draft.caseIds.length > 9) throw new Error('Select between one and nine authorized seed cases');
    const categories = [...new Set(cases.filter(seed => draft.caseIds.includes(seed.id)).map(seedCategory))];
    if (categories.length > 3) throw new Error('Seed cases may cover at most three categories');
    raw = { kind: 'adaptive', input: { ...shared, caseIds: draft.caseIds, categories, maxCases: draft.maxCases, maxMinutes: draft.maxMinutes } };
  }
  if (paid && !(Number(draft.cap) >= 0.000000001 && Number(draft.cap) <= 100)) throw new Error('Set an OpenRouter spend cap between $0.000000001 and $100');
  const parsed = runDefinition.safeParse(raw);
  if (!parsed.success) throw new Error(`Complete the run settings: ${parsed.error.issues[0]?.message ?? 'invalid input'}`);
  return parsed.data;
}

/** Saved definition -> editable draft; inactive roles fall back to the Judge assignment. */
export function draftFromDefinition(definition: Definition): Draft {
  const { run } = definition, input = run.input;
  const judge = run.kind === 'selected' ? run.input.roles?.judge ?? localAssignment(run.input.model) : run.input.roles.judge;
  const adaptive = run.kind === 'adaptive' ? run.input : null;
  return { name: definition.name, targetId: input.targetId, kind: run.kind, caseId: run.kind === 'selected' ? run.input.caseId : '', caseIds: adaptive?.caseIds ?? [],
    roles: { orchestrator: adaptive?.roles.orchestrator ?? judge, redTeam: adaptive?.roles.redTeam ?? judge, judge }, maxCases: adaptive?.maxCases ?? 3, maxMinutes: adaptive?.maxMinutes ?? 3,
    ollamaUrl: input.ollamaUrl ?? '', cap: String(input.openRouterCapUsd ?? 0.25) };
}

/** Stable identity of exactly what would be saved and launched; '' when the draft is not yet valid. */
export function draftKey(draft: Draft, cases: Seed[], name: string): string {
  try { return JSON.stringify([name, buildRun(draft, cases)]); } catch { return ''; }
}

export function usd(nanos: bigint): string {
  const sign = nanos < 0n ? '-' : '', abs = nanos < 0n ? -nanos : nanos;
  return `${sign}$${abs / 1_000_000_000n}.${(abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}

const issueText: Record<string, string> = {
  local_catalog_unavailable: 'local model catalog unavailable at this URL',
  local_model_missing: 'model not installed locally',
  paid_catalog_or_pricing_unavailable: 'OpenRouter catalog or verified pricing unavailable',
};
export const describeIssue = (issue: Preflight['issues'][number]) => `${issue.role ? `${roleLabel(issue.role)}: ` : ''}${issueText[issue.code] ?? issue.code.replaceAll('_', ' ')}`;

/** Why launch must not proceed for this preflight result, or null when it may. */
export function launchBlock(result: Preflight): string | null {
  if (result.status !== 'available') return `Launch blocked: ${result.issues.map(describeIssue).join('; ') || 'selected models unavailable'}`;
  if (!result.preview) return 'Launch blocked: the paid reservation could not be verified';
  if (result.preview.capNanos !== null && BigInt(result.preview.reservationNanos) > BigInt(result.preview.capNanos)) return 'Launch blocked: the conservative reservation exceeds the OpenRouter cap';
  return null;
}

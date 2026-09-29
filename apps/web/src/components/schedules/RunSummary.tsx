import React from 'react';
import type { RunDefinition } from '../../../../../packages/contracts/src/index.js';
import { activeRoles, localAssignment, roleLabel, usd, type Assignment, type Role } from '../models/definitions.js';

export type SummaryCase = { id: string; title: string | null; category: string };
const words = (value: string) => value.replaceAll('_', ' ');
const model = (value: { provider: string; model: string; maxOutputTokens: number }) => `${value.provider === 'ollama' ? 'Ollama' : 'OpenRouter'} ${value.model} (max ${value.maxOutputTokens} output tokens)`;

/** Target, mode, cases, active-role models, paid cap and report policy of one saved run, for a definition or a schedule snapshot. */
export function RunSummary({ run, target, cases }: { run: RunDefinition | null; target: { id: string; name: string | null }; cases: SummaryCase[] }) {
  if (!run) return <p className="hint">This schedule's saved run snapshot predates the current definition format, so its models and cap cannot be summarized here. Its cadence and history are unaffected.</p>;
  const { input } = run, roles: Partial<Record<Role, Assignment>> = run.kind === 'selected' ? { judge: run.input.roles?.judge ?? localAssignment(run.input.model) } : run.input.roles;
  const policy = input.reportPolicy;
  return <dl className="schedule-summary">
    <div><dt>Target</dt><dd>{target.name ?? `Unknown target ${target.id.slice(0, 8)}`}</dd></div>
    <div><dt>Mode</dt><dd>{run.kind === 'selected' ? 'Single case' : `Adaptive exploration (up to ${run.input.maxCases} cases, ${run.input.maxMinutes} min)`}</dd></div>
    <div><dt>{run.kind === 'selected' ? 'Case' : 'Seed cases'}</dt><dd>{cases.length ? cases.map(item => `${item.title ?? `Case ${item.id.slice(0, 8)}`} (${words(item.category)})`).join(', ') : 'None recorded'}</dd></div>
    <div><dt>Models</dt><dd>{activeRoles(run.kind).map(role => <span key={role}>{roleLabel(role)}: {roles[role] ? model(roles[role]) : 'not set'}</span>)}</dd></div>
    <div><dt>Paid cap</dt><dd>{input.openRouterCapUsd === undefined ? 'No paid calls' : `${usd(BigInt(Math.round(input.openRouterCapUsd * 1e9)))} per occurrence`}</dd></div>
    {policy && <div><dt>Report policy</dt><dd>{model(policy.model)}, review window {policy.reviewWindowMinutes} min{policy.allowanceUsd === undefined ? '' : `, allowance ${usd(BigInt(Math.round(policy.allowanceUsd * 1e9)))}`}</dd></div>}
  </dl>;
}

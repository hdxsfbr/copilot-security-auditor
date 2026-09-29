import React from 'react';
import { activeRoles, roleLabel, type Assignment, type Catalog, type Draft, type Provider, type Role } from './definitions.js';

const duties: Record<Role, string> = { orchestrator: 'Chooses the next seed case.', redTeam: 'Proposes bounded, validated turns.', judge: 'Assesses the recorded evidence.' };

/** Provider, model and output bound for each role the chosen run mode will actually invoke. */
export function RoleAssignments({ kind, roles, catalog, localModel, onChange }: {
  kind: Draft['kind']; roles: Draft['roles']; catalog: Catalog | null; localModel: string; onChange: (role: Role, patch: Partial<Assignment>) => void;
}) {
  const suggestions = (provider: Provider) => (provider === 'ollama' ? catalog?.ollama : catalog?.openrouter) ?? [];
  const switchProvider = (role: Role, provider: Provider) => onChange(role, { provider, model: provider === 'ollama' ? localModel || suggestions('ollama')[0] || '' : suggestions('openrouter')[0] ?? '' });
  return <div className="composer-roles">{activeRoles(kind).map(role => {
    const value = roles[role], name = roleLabel(role), list = `${role}-model-suggestions`;
    return <fieldset className="composer-role" key={role}>
      <legend>{name}</legend>
      <p className="hint">{duties[role]}</p>
      <label>{name} provider<select value={value.provider} onChange={event => switchProvider(role, event.target.value as Provider)}>
        <option value="ollama">Host Ollama (local)</option>
        <option value="openrouter" disabled={catalog?.availability.openrouter === 'not_configured' && value.provider !== 'openrouter'}>OpenRouter (paid)</option>
      </select></label>
      <label>{name} model<input required list={list} value={value.model} onChange={event => onChange(role, { model: event.target.value })}/></label>
      <datalist id={list}>{suggestions(value.provider).map(model => <option key={model} value={model}/>)}</datalist>
      <label>{name} maximum output tokens<input type="number" min={1} max={4096} required value={value.maxOutputTokens} onChange={event => onChange(role, { maxOutputTokens: Number(event.target.value) })}/></label>
    </fieldset>;
  })}</div>;
}

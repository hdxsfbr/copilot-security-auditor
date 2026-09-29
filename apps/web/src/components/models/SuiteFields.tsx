import React from 'react';
import { RoleAssignments } from './RoleAssignments.js';
import type { Catalog } from './definitions.js';
import type { SuiteForm } from '../regressions/model.js';

/** The Judge, its provider bounds and the suite bounds, for the composer's suite mode and the version-change trigger. */
export function SuiteFields({ form, catalog, localModel, onChange }: { form: SuiteForm; catalog: Catalog | null; localModel: string; onChange: (patch: Partial<SuiteForm>) => void }) {
  return <>
    <RoleAssignments kind="selected" roles={{ orchestrator: form.judge, redTeam: form.judge, judge: form.judge }} catalog={catalog} localModel={localModel} onChange={(_role, patch) => onChange({ judge: { ...form.judge, ...patch } })}/>
    {form.judge.provider === 'ollama'
      ? <label>Local model server URL<input type="url" required value={form.ollamaUrl} onChange={event => onChange({ ollamaUrl: event.target.value })}/></label>
      : <label>Maximum OpenRouter spend (USD, each item run)<input type="number" min="0.000000001" max="100" step="any" required value={form.cap} onChange={event => onChange({ cap: event.target.value })}/></label>}
    <div className="pair">
      <label>Maximum identities<input type="number" min={1} max={25} required value={form.maxItems} onChange={event => onChange({ maxItems: Number(event.target.value) })}/></label>
      <label>Maximum elapsed minutes<input type="number" min={1} max={240} required value={form.maxMinutes} onChange={event => onChange({ maxMinutes: Number(event.target.value) })}/></label>
    </div>
  </>;
}

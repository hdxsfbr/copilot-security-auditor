import React from 'react';
import type { Catalog, Provider, ReportDraft } from './definitions.js';

/** Optional automatic Documentation drafting for findings this run confirms. Off by default; nothing here approves a report. */
export function ReportPolicyFields({ value, catalog, localModel, onChange }: { value: ReportDraft; catalog: Catalog | null; localModel: string; onChange: (patch: Partial<ReportDraft>) => void }) {
  const suggestions = (value.provider === 'ollama' ? catalog?.ollama : catalog?.openrouter) ?? [];
  const switchProvider = (provider: Provider) => onChange({ provider, model: provider === 'ollama' ? localModel || catalog?.ollama[0] || '' : catalog?.openrouter[0] ?? '' });
  return <div className="composer-report">
    <label className="composer-choice"><input type="checkbox" checked={value.enabled} onChange={event => onChange({ enabled: event.target.checked })} />Draft reports automatically for findings this run confirms</label>
    <p className="hint">Off by default. When on, a finding confirmed while the review window is open is drafted by the Documentation model: redacted, cited, and never approved automatically. A paid model draws only the allowance below, held inside this run’s OpenRouter cap and released when the window ends; later confirmations need an explicit job and allowance.</p>
    {value.enabled && <fieldset className="composer-role"><legend>Documentation model</legend>
      <label>Documentation provider<select value={value.provider} onChange={event => switchProvider(event.target.value as Provider)}>
        <option value="ollama">Host Ollama (local)</option>
        <option value="openrouter" disabled={catalog?.availability.openrouter === 'not_configured' && value.provider !== 'openrouter'}>OpenRouter (paid)</option></select></label>
      <label>Documentation model<input required list="documentation-model-suggestions" value={value.model} onChange={event => onChange({ model: event.target.value })} /></label>
      <datalist id="documentation-model-suggestions">{suggestions.map(model => <option key={model} value={model} />)}</datalist>
      <label>Documentation maximum output tokens<input type="number" min={1} max={4096} required value={value.maxOutputTokens} onChange={event => onChange({ maxOutputTokens: Number(event.target.value) })} /></label>
      {value.provider === 'openrouter' && <label>Report allowance (USD, inside the run cap)<input type="number" min="0.000000001" max="100" step="any" required value={value.allowance} onChange={event => onChange({ allowance: event.target.value })} /></label>}
      <label>Review window (minutes after the run finishes)<input type="number" min={1} max={10080} required value={value.windowMinutes} onChange={event => onChange({ windowMinutes: Number(event.target.value) })} /></label>
    </fieldset>}
  </div>;
}

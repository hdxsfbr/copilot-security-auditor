import React, { useState } from 'react';
import type { VersionTrigger } from '../../../../../packages/contracts/src/regression-suites.js';
import { requestJson } from '../../api/client.js';
import { SuiteFields } from '../models/SuiteFields.js';
import { isTrigger, newSuiteForm, suiteSettings, versionText, when } from './model.js';

/** Opt-in, per target, off by default. It only queues a bounded suite when a finished run verifies a new version; it never deploys or patches. */
export function TriggerPanel({ triggers, model, ollamaUrl, reload }: { triggers: VersionTrigger[]; model: string; ollamaUrl: string; reload: () => void }) {
  const [editing, setEditing] = useState<string | null>(null), [form, setForm] = useState(() => newSuiteForm(model, ollamaUrl));
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  const save = async (targetId: string, body: object) => {
    setBusy(true); setProblem('');
    try { await requestJson(`/regression-triggers/${encodeURIComponent(targetId)}`, isTrigger, { method: 'PUT', body: JSON.stringify(body) }); setEditing(null); reload(); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : 'Trigger update failed'); }
    finally { setBusy(false); }
  };
  if (!triggers.length) return <p className="hint">No targets yet.</p>;
  return <>{problem && <p role="alert" className="alert">{problem}</p>}<ul className="trigger-list">{triggers.map(trigger => <li key={trigger.targetId}>
    <p><strong>{trigger.targetName}</strong> · version-change trigger <strong>{trigger.enabled ? 'on' : 'off'}</strong>{trigger.enabled ? '' : ' (default)'}
      {trigger.enabled && trigger.settings && <> · up to {trigger.settings.maxItems} identities, {trigger.settings.maxMinutes} min, Judge {trigger.settings.roles.judge.model}</>}</p>
    <p className="hint">Last verified version seen: {trigger.lastSeenVersion ? versionText(trigger.lastSeenVersion) : 'none yet'} · last suite queued for: {trigger.lastTriggeredVersion ?? 'none'}{trigger.updatedAt && <> · changed {when(trigger.updatedAt)}</>}</p>
    {trigger.enabled
      ? <button type="button" disabled={busy} onClick={() => void save(trigger.targetId, { enabled: false })}>Turn off for {trigger.targetName}</button>
      : editing === trigger.targetId ? <form className="trigger-form" onSubmit={event => { event.preventDefault(); void save(trigger.targetId, { enabled: true, settings: suiteSettings(form) }); }}>
        <p className="hint">When a finished run verifies a newly observed version of this target, one bounded suite of its confirmed identities is queued, once per version, using the normal reservation and paid-call cap. It never deploys or patches the target.</p>
        <fieldset disabled={busy}><SuiteFields form={form} catalog={null} localModel={model} onChange={patch => setForm(value => ({ ...value, ...patch }))}/></fieldset>
        <button className="primary" type="submit" disabled={busy}>Turn on for {trigger.targetName}</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
      </form> : <button type="button" onClick={() => { setForm(newSuiteForm(model, ollamaUrl)); setEditing(trigger.targetId); }}>Turn on for {trigger.targetName}…</button>}
  </li>)}</ul></>;
}

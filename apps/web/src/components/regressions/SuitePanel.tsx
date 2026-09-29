import React, { useState } from 'react';
import type { SuiteList } from '../../../../../packages/contracts/src/regression-suites.js';
import { requestJson } from '../../api/client.js';
import { RouteLink } from '../router.js';
import { isSuiteDetail, signalText, versionText, when, words } from './model.js';
import { useLoaded } from './useLoaded.js';

function Items({ id, navigate }: { id: string; navigate: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useLoaded(`/regression-suites/${id}`, isSuiteDetail, open, detail => detail?.state === 'active');
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Items</summary>
    {error && <p role="alert" className="alert">Suite unavailable: {error}</p>}
    {data && <ol className="suite-items">{data.items.map(item => <li key={item.ordinal}>
      <strong>{item.title ?? 'Identity'}</strong> · {item.state === 'skipped' ? `not run: ${words(item.reason ?? 'skipped')}` : item.state === 'finished' ? `${item.outcome} (${signalText(item.signal)}) on ${versionText(item.targetVersion)}${item.versionCheck === 'differs' ? ' — differs from the version named for this suite' : ''}` : words(item.state)}
      {item.runId && <> · <RouteLink href={`/runs/${encodeURIComponent(item.runId)}`} navigate={navigate}>run {item.runId.slice(0, 8)}</RouteLink></>}
    </li>)}</ol>}
  </details>;
}

/** Suite status. A blocked, incomplete or skipped item stays visible as recorded; nothing here reads a missing result as safe. */
export function SuitePanel({ list, reload, navigate }: { list: SuiteList; reload: () => void; navigate: (path: string) => void }) {
  const [problem, setProblem] = useState('');
  const stop = async (id: string) => {
    try { await requestJson(`/regression-suites/${encodeURIComponent(id)}/stop`, (value): value is unknown => true, { method: 'POST' }); setProblem(''); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : 'Stop failed'); }
    reload();
  };
  if (!list.items.length) return <p className="hint">No suites yet. Start one from the composer or validate a new version above.</p>;
  return <>{problem && <p role="alert" className="alert">{problem}</p>}<ul className="suite-list">{list.items.map(suite => <li key={suite.id}>
    <p><strong>{suite.targetName ?? 'Target'}</strong> · {suite.trigger === 'manual' ? 'operator suite' : 'version-change trigger'} · <span className={`suite-state suite-${suite.state}`}>{suite.state}</span>
      {suite.expectedVersion && <> · version {suite.expectedVersion}</>} · {when(suite.createdAt)}</p>
    <p className="hint">{suite.counts.finished} finished, {suite.counts.running} running, {suite.counts.pending} pending, {suite.counts.skipped} not run
      {Object.keys(suite.outcomes).length > 0 && <> · {Object.entries(suite.outcomes).map(([outcome, count]) => `${count} ${words(outcome)}`).join(', ')}</>}{suite.omittedCount > 0 && <> · {suite.omittedCount} beyond the item bound were not included</>}</p>
    {suite.state === 'active' && <button type="button" onClick={() => void stop(suite.id)}>Stop suite</button>}
    <Items id={suite.id} navigate={navigate}/>
  </li>)}</ul></>;
}

import React, { useState } from 'react';
import type { RegressionIdentityList } from '../../../../../packages/contracts/src/regressions.js';
import { RouteLink } from '../router.js';
import { StateChip } from './StateChip.js';
import { isIdentityDetail, reasonText, signalText, versionText, when, words } from './model.js';
import { useLoaded } from './useLoaded.js';

const runLink = (id: string) => `/runs/${encodeURIComponent(id)}`;

function Lineage({ id, count, navigate }: { id: string; count: number; navigate: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useLoaded(`/regression-identities/${id}`, isIdentityDetail, open);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Replay lineage ({count})</summary>
    {error && <p role="alert" className="alert">Lineage unavailable: {error}</p>}
    {open && !data && !error && <p role="status">Loading lineage…</p>}
    {data && <ol className="lineage" aria-label="Replay lineage, newest first">
      {data.replays.map(replay => <li key={replay.id}>{when(replay.createdAt)} · {words(replay.trigger)} · {replay.targetName ?? 'target'} · {versionText(replay.targetVersion)} · {replay.status === 'finished' ? `${replay.outcome} (${signalText(replay.signal)})` : words(replay.status)} · <RouteLink href={runLink(replay.runId)} navigate={navigate}>run {replay.runId.slice(0, 8)}</RouteLink></li>)}
      {!data.replays.length && <li>No replay has run yet.</li>}
    </ol>}
  </details>;
}

/** Identities with the derived state per target and observed version; unknown is shown as unknown, never as fixed. */
export function IdentityList({ list, navigate }: { list: RegressionIdentityList; navigate: (path: string) => void }) {
  if (!list.items.length) return <p className="hint">No confirmed regression identities match. Confirm a finding first.</p>;
  return <>{list.items.map(item => <article className="identity-card" key={item.id}>
    <strong>{item.title ?? item.firstMessage}</strong>
    <p className="hint">{words(item.category ?? 'uncategorized')} · user {item.user} · {item.sourceFindingCount} finding{item.sourceFindingCount === 1 ? '' : 's'} · {item.replayCount} replay{item.replayCount === 1 ? '' : 's'}</p>
    {item.targetStates.length ? item.targetStates.map(state => <div className="identity-target" key={state.targetId}>
      <p><strong>{state.targetName ?? 'Target'}</strong> <StateChip state={state.current.state} version={state.current.targetVersion}/>{state.pendingReplays > 0 && <span className="hint"> · {state.pendingReplays} replay in progress</span>}</p>
      <ul className="state-scopes" aria-label={`States by version on ${state.targetName ?? 'target'}, newest first`}>
        {state.scopes.map(scope => <li key={`${scope.runId}-${scope.targetVersion}`}><StateChip state={scope.state} version={scope.targetVersion}/> <span>{reasonText[scope.reason]} · from {scope.basis === 'source_finding' ? 'the finding' : 'a replay'}, <RouteLink href={runLink(scope.runId)} navigate={navigate}>run {scope.runId.slice(0, 8)}</RouteLink> · {when(scope.observedAt)}</span></li>)}
      </ul>
    </div>) : <p className="hint">No recorded observation on the selected target.</p>}
    <Lineage id={item.id} count={item.replayCount} navigate={navigate}/>
  </article>)}{list.nextCursor && <p className="hint">Showing the newest {list.items.length}; narrow by target to see more.</p>}</>;
}

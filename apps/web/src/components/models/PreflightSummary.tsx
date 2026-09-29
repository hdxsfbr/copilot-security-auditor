import React from 'react';
import { describeIssue, usd, type Catalog, type Preflight } from './definitions.js';

const state = (value: string) => value.replaceAll('_', ' ');
// An empty but reachable catalog is reported differently from an unreachable one.
const discovery = (catalog: Catalog | null, key: 'ollama' | 'openrouter') => !catalog ? 'loading' : catalog.availability[key] === 'available' ? `available (${catalog[key].length} listed)` : state(catalog.availability[key]);

function Reservation({ result }: { result: Preflight }) {
  const { preview } = result;
  if (!preview) return <p>Paid reservation unknown, so launch is blocked. It is never treated as $0.</p>;
  const reserve = BigInt(preview.reservationNanos), cap = preview.capNanos === null ? null : BigInt(preview.capNanos), held = BigInt(preview.reportAllowanceNanos ?? '0');
  const report = preview.reportAllowanceNanos === undefined ? null : <p>Report drafting: {held === 0n ? 'local Documentation model, no paid allowance.' : <>allowance <strong>{usd(held)}</strong> held inside the cap; one bounded Documentation call reserves <strong>{usd(BigInt(preview.reportJobReservationNanos ?? '0'))}</strong>. Execution headroom is the cap minus this allowance.</>}</p>;
  if (cap === null) return <><p>{reserve === 0n && result.paid.status === 'not_required' ? '$0 paid reservation; local inference unverified.' : `Conservative reservation ${usd(reserve)}.`}</p>{report}</>;
  const remaining = cap - reserve - held;
  return <><p>Conservative reservation <strong>{usd(reserve)}</strong> for up to {preview.attempts} attempt{preview.attempts === 1 ? '' : 's'}, against a cap of {usd(cap)}.
    {' '}Remaining allowance <strong className={remaining < 0n ? 'composer-over' : undefined}>{usd(remaining)}</strong>{remaining < 0n && ' (over cap)'}. This is a hold before dispatch, not the expected bill.</p>{report}</>;
}

/** Live-region summary of the preflight for the exact current draft. */
export function PreflightSummary({ result, checking, catalog }: { result: Preflight | null; checking: boolean; catalog: Catalog | null }) {
  return <div className="composer-preflight" role="status">
    <h3>Availability and reservation</h3>
    {checking ? <p>Checking model catalogs and the paid reservation…</p> : !result ? <p>Not checked for these exact settings. Start runs this check first; it never contacts the target or runs inference.</p> : <>
      <ul>
        <li>Local models: {state(result.local.status)}{result.local.status === 'available' && ` (${result.local.installed.length} installed)`}</li>
        <li>OpenRouter catalog and pricing: {state(result.paid.status)}</li>
      </ul>
      <Reservation result={result}/>
      {result.issues.length > 0 && <ul className="composer-issues">{result.issues.map((issue, index) => <li key={index}>{describeIssue(issue)}</li>)}</ul>}
    </>}
    <p className="hint">Catalog discovery: local {discovery(catalog, 'ollama')}, OpenRouter {discovery(catalog, 'openrouter')}. Discovery does not prove inference health; it is unverified.</p>
  </div>;
}

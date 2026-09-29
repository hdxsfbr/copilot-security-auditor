import React, { useEffect, useRef, useState } from "react";
import { isRecord, requestJson } from "../../api/client.js";
import { RouteLink } from "../router.js";
import { useWorkspace } from "../../pages/context.js";
import "./style.css";

type Totals = { providerReportedNanos: string; operatorReconciledNanos: string; reservedNanos: string; unresolvedNanos: string; unresolvedCalls: number };
type Call = { id: string; runId: string; targetName: string | null; reportJobId: string | null; role: string; model: string; reservedNanos: string; reportedChargeNanos: string | null; providerGenerationId: string | null; ageSeconds: number; maxChargeNanos: string };
type Report = { totals: Totals; calls: Call[]; truncated: boolean };
type Recorded = { replayed: boolean; reconciliation: { resolution: string; chargeNanos: string }; call: { id: string } };
const nanosText = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const isTotals = (value: unknown): value is Totals => isRecord(value) && nanosText(value.providerReportedNanos) && nanosText(value.operatorReconciledNanos) && nanosText(value.reservedNanos) && nanosText(value.unresolvedNanos) && Number.isInteger(value.unresolvedCalls);
const isCall = (value: unknown): value is Call => isRecord(value) && typeof value.id === "string" && typeof value.runId === "string" && (value.targetName === null || typeof value.targetName === "string") && (value.reportJobId === null || typeof value.reportJobId === "string")
  && typeof value.role === "string" && typeof value.model === "string" && nanosText(value.reservedNanos) && (value.reportedChargeNanos === null || nanosText(value.reportedChargeNanos)) && (value.providerGenerationId === null || typeof value.providerGenerationId === "string") && Number.isInteger(value.ageSeconds) && nanosText(value.maxChargeNanos);
const isReport = (value: unknown): value is Report => isRecord(value) && isTotals(value.totals) && Array.isArray(value.calls) && value.calls.every(isCall) && typeof value.truncated === "boolean";
const isRecorded = (value: unknown): value is Recorded => isRecord(value) && typeof value.replayed === "boolean" && isRecord(value.reconciliation) && typeof value.reconciliation.resolution === "string" && nanosText(value.reconciliation.chargeNanos) && isRecord(value.call) && typeof value.call.id === "string";
// Integer arithmetic only: amounts are nano strings and are never converted to a float.
const dollars = (nanos: string) => { const value = BigInt(nanos); let fraction = (value % 1_000_000_000n).toString().padStart(9, "0"); while (fraction.length > 6 && fraction.endsWith("0")) fraction = fraction.slice(0, -1); return `$${value / 1_000_000_000n}.${fraction}`; };
const age = (seconds: number) => seconds < 60 ? "under a minute" : seconds < 3600 ? `${Math.floor(seconds / 60)} min` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min` : `${Math.floor(seconds / 86400)} d ${Math.floor(seconds % 86400 / 3600)} h`;
// getRandomValues works on plain-HTTP trusted-LAN origins where crypto.randomUUID does not.
const newKey = () => `ui-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
const usdInput = /^(0|[1-9]\d*)(\.\d{1,9})?$/;

function ReconcileForm({ call, onRecorded }: { call: Call; onRecorded: (result: Recorded) => void }) {
  const [resolution, setResolution] = useState<"settled_by_operator" | "confirmed_not_billed">("settled_by_operator");
  const [charge, setCharge] = useState(""), [evidence, setEvidence] = useState(""), [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitting = useRef(false), attempt = useRef({ signature: "", key: "" });
  const paid = resolution === "settled_by_operator";
  const invalid = !evidence.trim() ? "Evidence is required." : paid && !usdInput.test(charge.trim()) ? "Enter the charge as a decimal dollar amount with at most 9 decimal places." : paid && !/[1-9]/.test(charge) ? "A recorded charge must be greater than zero." : "";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || invalid || !attested) return;
    submitting.current = true; setBusy(true); setError("");
    const payload = { resolution, ...(paid ? { chargeUsd: charge.trim() } : {}), evidence: evidence.trim() };
    // The same request keeps one key, so retrying after a lost response replays instead of double-recording.
    const signature = JSON.stringify(payload);
    if (attempt.current.signature !== signature) attempt.current = { signature, key: newKey() };
    try { onRecorded(await requestJson(`/spend/calls/${call.id}/reconcile`, isRecorded, { method: "POST", body: JSON.stringify({ ...payload, idempotencyKey: attempt.current.key }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Reconciliation failed"); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <form className="spend-form" onSubmit={event => void submit(event)} aria-label={`Reconcile ${call.role} call`}>
    <p className="spend-warning" role="note"><strong>This records an operator attestation.</strong> The amount and evidence are stored permanently and cannot be edited. Nothing is verified with the provider, no run is restarted, and other unresolved calls stay held.</p>
    <label>Resolution<select value={resolution} onChange={event => setResolution(event.target.value as typeof resolution)}>
      <option value="settled_by_operator">Provider charged this amount</option><option value="confirmed_not_billed">Confirmed not billed</option></select></label>
    {paid && <label>Charge in USD (at most {dollars(call.maxChargeNanos)})<input inputMode="decimal" autoComplete="off" value={charge} onChange={event => setCharge(event.target.value)} placeholder="0.001200" required/></label>}
    <label>Evidence: provider dashboard reference, generation id or invoice line<input maxLength={500} autoComplete="off" value={evidence} onChange={event => setEvidence(event.target.value)} required/></label>
    <label className="spend-attest"><input type="checkbox" checked={attested} onChange={event => setAttested(event.target.checked)}/> I checked this against the provider's own records.</label>
    {error && <p role="alert" className="alert">{error}</p>}
    <button type="submit" className="primary" disabled={busy || !!invalid || !attested} aria-busy={busy}>{busy ? "Recording…" : "Record reconciliation"}</button>
    {invalid && (evidence || charge) && <p className="hint">{invalid}</p>}
  </form>;
}

export function SpendPanel() {
  const { navigate } = useWorkspace();
  const [report, setReport] = useState<Report | null>(null), [error, setError] = useState(""), [open, setOpen] = useState(""), [recorded, setRecorded] = useState<Recorded | null>(null);
  const sequence = useRef(0);
  const load = async () => {
    const request = ++sequence.current;
    try { const next = await requestJson("/spend/unresolved", isReport); if (sequence.current === request) { setReport(next); setError(""); } }
    catch (cause) { if (sequence.current === request) setError(cause instanceof Error ? cause.message : "Unresolved spend unavailable"); }
  };
  useEffect(() => { void load(); return () => { sequence.current++; }; }, []);
  const done = (result: Recorded) => { setRecorded(result); setOpen(""); void load(); };
  const totals = report?.totals;
  return <section className="panel spend-panel" aria-labelledby="spend-heading">
    <div className="eyebrow">PAID SPEND</div><h2 id="spend-heading">Unresolved spend</h2>
    <p className="hint">Reserved, provider-reported, operator-reconciled and unresolved amounts are kept apart. An unresolved charge stays held until you record evidence for it. Local inference has no price and never appears here.</p>
    <button type="button" onClick={() => void load()}>Refresh spend</button>
    {error && <p role="alert" className="alert">{error} <button type="button" onClick={() => void load()}>Retry spend</button></p>}
    {recorded && <p role="status" className="spend-recorded">{recorded.reconciliation.resolution === "confirmed_not_billed" ? "Recorded as confirmed not billed ($0)." : `Recorded operator-attested charge ${dollars(recorded.reconciliation.chargeNanos)}.`}{recorded.replayed ? " This request was already recorded; nothing changed." : ""} The evidence is retained with the call.</p>}
    {totals && <dl className="spend-totals" aria-label="Spend totals">
      <div><dt>Provider-reported</dt><dd>{dollars(totals.providerReportedNanos)}</dd></div>
      <div><dt>Operator-reconciled</dt><dd>{dollars(totals.operatorReconciledNanos)}</dd></div>
      <div><dt>Reserved in flight</dt><dd>{dollars(totals.reservedNanos)}</dd></div>
      <div><dt>Unresolved (held)</dt><dd>{dollars(totals.unresolvedNanos)} · {totals.unresolvedCalls} call{totals.unresolvedCalls === 1 ? "" : "s"}</dd></div>
    </dl>}
    {report && !report.calls.length && <p role="status">No unresolved paid calls.</p>}
    {report?.calls.map(call => <article className="review-item spend-call" key={call.id}>
      <strong>{call.role} · {call.model}</strong>
      <p>{call.targetName ?? "Unnamed target"} · held {age(call.ageSeconds)} · reserve {dollars(call.reservedNanos)}{call.reportJobId ? " · post-run report call" : ""}</p>
      <p>{call.reportedChargeNanos ? `Provider reported ${dollars(call.reportedChargeNanos)}, above the reserve, so it is unresolved.` : "No charge was reported."} {call.providerGenerationId ? <>Provider reference <code>{call.providerGenerationId}</code></> : "No provider reference was recorded."}</p>
      <RouteLink href={`/runs/${call.runId}`} navigate={navigate}>Inspect run</RouteLink>{" "}
      <button type="button" aria-expanded={open === call.id} onClick={() => setOpen(open === call.id ? "" : call.id)}>{open === call.id ? "Close" : "Reconcile…"}</button>
      {open === call.id && <ReconcileForm call={call} onRecorded={done}/>}
    </article>)}
    {report?.truncated && <p className="hint">Showing the oldest {report.calls.length} unresolved calls. Totals include all of them.</p>}
  </section>;
}

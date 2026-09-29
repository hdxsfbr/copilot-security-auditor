import React from "react";
import type { Event } from "../../pages/controller.js";

const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const string = (v: unknown) => typeof v === "string" ? v : "";
const list = (v: unknown) => Array.isArray(v) ? v : [];
export function turnNumbers(events: Event[]) {
  const recorded = events.filter(item => item.event.kind === "turn").map(item => {
    const observed = record(item.event.detail.observation)?.turn;
    return Number.isSafeInteger(observed) && Number(observed) > 0 ? Number(observed) : null;
  });
  return recorded.map(turn => turn !== null && recorded.filter(value => value === turn).length === 1 ? turn : null);
}

export function EvidenceContent({ kind, detail }: { kind: string; detail: Record<string, unknown> }) {
  const observation = record(detail.observation);
  const policy = record(detail.policy);
  const verdict = record(detail.verdict);
  if (kind === "turn") return <>
    <p><strong>{detail.action === "attach_pdf" ? "Synthetic PDF + message" : "Chat message"}:</strong> {string(detail.message) || "Message unavailable"}</p>
    <p><strong>Visible response:</strong> {string(observation?.response) || "No response text recorded"}</p>
    <p>Status: {string(observation?.status) || "unknown"} · completeness: {string(record(observation?.completeness)?.state) || "not recorded"}</p>
    {list(observation?.claims).map((value, index) => { const claim = record(value); return claim && <p key={index}>Claim {index + 1}: {string(claim.text)} · source references: {list(claim.sources).map(source => string(record(source)?.locator) || string(record(source)?.support) || "unspecified").join(", ") || "none"}</p>; })}
  </>;
  if (kind === "deterministic") return <><strong>Deterministic checks</strong>{list(detail.checks).map((value, index) => { const check = record(value); return <p key={index}>{string(check?.kind) || `Check ${index + 1}`}: {string(check?.outcome) || "undecidable"}{string(check?.coveredClaim) ? ` · ${string(check?.coveredClaim)}` : ""}{string(check?.signal) ? ` · signal ${string(check?.signal)}` : ""} · references {list(check?.evidenceRefs).filter(ref => typeof ref === "string").join(", ") || "none"}</p>; })}</>;
  if (kind === "policy") return <p><strong>Policy gate:</strong> {string(policy?.outcome) || "undecidable"}{list(policy?.failed).length ? ` · limitations: ${list(policy?.failed).filter(value => typeof value === "string").join(", ")}` : ""}. This concerns recorded evidence only; it does not independently prove absence of chart writes or other-chart access.</p>;
  if (kind === "verdict") return <><p><strong>Judge outcome:</strong> {string(verdict?.outcome) || "unknown"}</p><p><strong>Judge claim:</strong> {string(verdict?.claim) || "No claim recorded"}</p>{string(verdict?.evidenceQuote) && <blockquote>{string(verdict?.evidenceQuote)}</blockquote>}<p>Source references: {list(verdict?.evidenceRefs).filter(value => typeof value === "string").join(", ") || "none"}</p></>;
  return <p>{string(detail.reason) || string(detail.scope) || string(detail.version) || "Recorded event"}</p>;
}

export function RunEvidence({ events, localTurns = true }: { events: Event[]; localTurns?: boolean }) {
  const numbers = turnNumbers(events);
  let count = 0;
  return <ol className="run-evidence-list">{events.map(item => {
    const turn = item.event.kind === "turn" ? numbers[count++] : null;
    const anchor = turn && localTurns ? `turn-${turn}` : `event-${item.id}`;
    return <li key={item.id} id={anchor} tabIndex={-1}>
      <div className="run-event-head"><strong>{turn && localTurns ? `Turn ${turn} · ` : ""}{item.event.agent} / {item.event.kind}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString()}</time></div>
      <EvidenceContent kind={item.event.kind} detail={item.event.detail} />
      <details><summary>Raw event JSON · ID {item.id}</summary><pre>{JSON.stringify(item.event.detail, null, 2)}</pre></details>
    </li>;
  })}</ol>;
}

import React, { useEffect, useRef, useState } from "react";
import { isRecord, requestJson } from "../api/client.js";
import { EvidenceContent, RunEvidence, turnNumbers } from "../components/evidence/RunEvidence.js";
import { RouteLink } from "../components/router.js";
import { useWorkspace } from "./context.js";

type CaseRow = { id: string; ordinal: number; category: string; state: string; executed: boolean; reason: string | null };
type Assessment = { checks: Record<string, unknown>[]; verdict: Record<string, unknown> | null; route: string };
type CaseDetail = CaseRow & { runId: string; admittedDefinition: Record<string, unknown> | null; sourceSeed: { id: string; familyId: string | null; version: number | null; definition: Record<string, unknown> | null }; eventIds: string[]; eventLinkage: "tagged" | "unknown"; assessment?: Assessment | null };
const str = (v: unknown): v is string => typeof v === "string";
const nullable = (v: unknown): v is string | null => v === null || str(v);
const isCaseRow = (v: unknown): v is CaseRow => isRecord(v) && str(v.id) && Number.isInteger(v.ordinal) && str(v.category) && str(v.state) && typeof v.executed === "boolean" && nullable(v.reason);
const isRows = (v: unknown): v is CaseRow[] => Array.isArray(v) && v.every(isCaseRow);
const isCaseDetail = (v: unknown): v is CaseDetail => {
  if (!isCaseRow(v)) return false;
  const row = v as unknown as Record<string, unknown>;
  const seed = row.sourceSeed;
  const assessment = row.assessment;
  if (assessment !== undefined && assessment !== null && !(isRecord(assessment) && Array.isArray(assessment.checks) && assessment.checks.every(isRecord) && (assessment.verdict === null || isRecord(assessment.verdict)) && str(assessment.route))) return false;
  return str(row.runId) && (row.admittedDefinition === null || isRecord(row.admittedDefinition)) && isRecord(seed) && str(seed.id) && nullable(seed.familyId) && (seed.version === null || Number.isInteger(seed.version)) && (seed.definition === null || isRecord(seed.definition)) && Array.isArray(row.eventIds) && row.eventIds.every((id: unknown) => str(id) && /^\d+$/.test(id)) && (row.eventLinkage === "tagged" || row.eventLinkage === "unknown");
};
const title = (value: unknown) => isRecord(value) && str(value.title) ? value.title : "Saved case";
function SavedDocuments({ caseId, definition }: { caseId: string; definition: Record<string, unknown> | null }) {
  const actions = definition && Array.isArray(definition.actions) ? definition.actions : [];
  return <>{actions.map((action, index) => isRecord(action) && action.kind === "attach_pdf" && str(action.artifactId) && (action.documentType === "lab_pdf" || action.documentType === "intake_form") ? <p key={index}><a href={`/api/cases/${encodeURIComponent(caseId)}/artifacts/${encodeURIComponent(action.artifactId)}?documentType=${action.documentType}`}>Download restricted synthetic PDF for step {index + 1}</a></p> : null)}</>;
}

export function RunDetailPage({ runId, executionCaseId }: { runId: string; executionCaseId?: string }) {
  const { run, events, runError, pollRun, navigate } = useWorkspace();
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [caseError, setCaseError] = useState("");
  const [caseBusy, setCaseBusy] = useState(false);
  const [loadedKey, setLoadedKey] = useState("");
  const caseKey = `${runId}/${executionCaseId ?? ""}`;
  const caseIdentity = useRef(caseKey), caseSequence = useRef(0), focusedAnchor = useRef("");
  caseIdentity.current = caseKey;
  const adaptive = run?.mode === "adaptive" || !!run?.categories;
  const loadCases = async () => {
    if (!adaptive) return;
    const key = caseKey, request = ++caseSequence.current;
    setCaseBusy(true);
    try {
      const [rows, detail] = await Promise.all([
        requestJson(`/runs/${runId}/cases`, isRows),
        executionCaseId ? requestJson(`/runs/${runId}/cases/${executionCaseId}`, isCaseDetail) : Promise.resolve(null),
      ]);
      if (caseIdentity.current !== key || caseSequence.current !== request) return;
      if (detail && (detail.id !== executionCaseId || detail.runId !== runId || !rows.some(row => row.id === detail.id))) throw new Error("Case identity does not match this run");
      setCases(rows); setCaseDetail(detail); setLoadedKey(key); setCaseError("");
    } catch (cause) { if (caseIdentity.current === key && caseSequence.current === request) setCaseError(cause instanceof Error ? cause.message : "Case evidence unavailable"); }
    finally { if (caseIdentity.current === key && caseSequence.current === request) setCaseBusy(false); }
  };
  useEffect(() => {
    setCases([]); setCaseDetail(null); setLoadedKey(""); setCaseError("");
    return () => { caseSequence.current++; };
  }, [caseKey]);
  useEffect(() => {
    if (!adaptive) return;
    void loadCases();
    if (run?.status === "finished") return;
    const timer = setInterval(() => { if (!document.hidden) void loadCases(); }, 1500);
    return () => clearInterval(timer);
  }, [caseKey, adaptive, run?.status]);
  useEffect(() => {
    const focus = () => {
      const hash = window.location.hash;
      if (!/^#turn-[1-9]\d*$/.test(hash) || executionCaseId && caseDetail?.id !== executionCaseId) return;
      const intent = `${caseKey}${hash}`;
      if (focusedAnchor.current === intent) return;
      const anchor = document.getElementById(hash.slice(1));
      if (anchor) { focusedAnchor.current = intent; anchor.scrollIntoView(); anchor.focus(); }
    };
    const frame = requestAnimationFrame(focus);
    window.addEventListener("hashchange", focus);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", focus); };
  }, [caseKey, caseDetail?.id, events.length]);
  if (!run || run.id !== runId) return <p role="status">Loading run evidence…</p>;
  if (run.status === "loading") return runError ? <p role="alert">Run evidence is unavailable. {runError} <button type="button" onClick={() => void pollRun(runId)}>Retry</button></p> : <p role="status">Loading run evidence…</p>;
  const exact = loadedKey === caseKey && executionCaseId && caseDetail?.id === executionCaseId && caseDetail.runId === runId ? caseDetail : null;
  const visibleCases = loadedKey === caseKey ? cases : [];
  const tagged = events.filter(item => typeof item.event.detail.executionCaseId === "string");
  const uncorrelated = events.filter(item => typeof item.event.detail.executionCaseId !== "string");
  const exactEvents = exact ? tagged.filter(item => item.event.detail.executionCaseId === exact.id && exact.eventIds.includes(String(item.id))) : [];
  return <section className="evidence run-detail" aria-label="Run evidence">
    <div className="evidence-top"><div><div className="eyebrow">SAVED RUN</div><h2>{executionCaseId ? "Exact execution case" : "Run evidence"}</h2></div><div className="status">{run.status} / {run.outcome ?? "awaiting result"}</div></div>
    <div className="run-meta">RUN {run.id} · {adaptive ? "ADAPTIVE" : "SELECTED"} · TARGET {run.target?.name || run.target?.id || "loading"} / {run.target?.version || run.version || "awaiting handshake"} · JUDGE {run.modelSnapshot?.roles.judge.provider || "unknown"} / {run.model || "unknown"}</div>
    <div className="run-detail-actions"><RouteLink href="/runs" navigate={navigate}>← Run history</RouteLink>{executionCaseId && <RouteLink href={`/runs/${runId}`} navigate={navigate}>All cases</RouteLink>}<button type="button" onClick={() => { void pollRun(runId); void loadCases(); }}>Refresh {run.status === "finished" ? "saved evidence" : "now"}</button></div>
    {run.stopRequested && <p role="status">Stop requested. In-flight work may still finish.</p>}
    {runError && <p role="alert">Run evidence could not refresh; the last saved evidence is retained. {runError} <button type="button" onClick={() => void pollRun(runId)}>Retry</button></p>}
    {!adaptive && <p>Saved selected case: <strong>{title(run.caseSnapshot?.definition)}</strong>{run.caseSnapshot?.version ? ` · version ${run.caseSnapshot.version}` : ""}. The execution uses this saved definition, even if the catalog later changes.</p>}
    {!adaptive && run.caseSnapshot && <SavedDocuments caseId={run.caseSnapshot.id} definition={run.caseSnapshot.definition} />}
    {adaptive && run.adaptiveSeeds && <p>Saved seed snapshot: {run.adaptiveSeeds.map(seed => `${title(seed.definition)}${seed.version ? ` v${seed.version}` : ""}`).join(" · ") || "none"}. The execution uses these saved definitions.</p>}
    {adaptive && <><h3>Executed cases</h3>{caseBusy && loadedKey !== caseKey && <p role="status">Loading exact cases…</p>}{caseError && <p role="alert">Case evidence could not refresh; saved evidence remains visible when available. {caseError} <button type="button" onClick={() => void loadCases()}>Retry cases</button></p>}{visibleCases.length > 0 ? <ol className="run-case-list">{visibleCases.map(item => <li key={item.id}><RouteLink href={`/runs/${runId}/cases/${item.id}`} navigate={navigate}>Case {item.ordinal}: {item.category.replaceAll("_", " ")}</RouteLink> · {item.state}{item.executed ? " · executed" : " · not executed"}{item.reason && <span> · {item.reason}</span>}</li>)}</ol> : !caseBusy && !caseError && <p>No case admitted yet; untested categories remain gaps.</p>}</>}
    {executionCaseId && !caseBusy && !exact && <p role="alert">This execution case is unavailable or does not belong to this run. Use the case list to retry.</p>}
    {exact && <><p>Case {exact.ordinal}: {title(exact.admittedDefinition || exact.sourceSeed.definition)} · source seed {exact.sourceSeed.id} · {exact.state}</p>{exact.eventLinkage === "unknown" && <p>Event linkage is unknown; no events are assigned by order or proximity.</p>}</>}
    {exact && <SavedDocuments caseId={exact.sourceSeed.id} definition={exact.admittedDefinition || exact.sourceSeed.definition} />}
    {exact?.eventLinkage === "unknown" && exact.assessment && <section aria-label="Saved case assessment"><h3>Saved case assessment</h3><p>Recorded route: {exact.assessment.route}. This assessment belongs to this case; its turn events are not linked.</p><EvidenceContent kind="deterministic" detail={{ checks: exact.assessment.checks }} />{exact.assessment.verdict ? <EvidenceContent kind="verdict" detail={{ verdict: exact.assessment.verdict }} /> : <p>Judge verdict unavailable.</p>}<details><summary>Raw saved assessment JSON</summary><pre>{JSON.stringify(exact.assessment, null, 2)}</pre></details></section>}
    <h3>{adaptive ? exact ? "Case-local turns and checks" : "Run-level events" : "Turns and checks"}</h3>
    {(!adaptive || exact) && <nav className="run-turn-nav" aria-label="Recorded turns">{turnNumbers(adaptive ? exactEvents : events).filter(number => number !== null).map(number => <a key={number} href={`#turn-${number}`}>Turn {number}</a>)}</nav>}
    {adaptive ? exact ? exactEvents.length ? <RunEvidence events={exactEvents} /> : <p className="empty">No tagged events for this execution case.</p> : uncorrelated.length ? <details><summary>Uncorrelated historical and run-level events ({uncorrelated.length})</summary><p>These events have no verified case identity and are never assigned by order.</p><RunEvidence events={uncorrelated} localTurns={false} /></details> : <p className="empty">Choose an execution case for exact evidence.</p> : events.length ? <RunEvidence events={events} /> : <p className="empty">No turns recorded yet. Incomplete work does not count as safe.</p>}
    {adaptive && exact && uncorrelated.length > 0 && <details><summary>Uncorrelated historical and run-level events ({uncorrelated.length})</summary><RunEvidence events={uncorrelated} localTurns={false} /></details>}
  </section>;
}

import React, { useEffect } from "react";
import { requestJson } from "../api/client.js";
import { DecisionPanel } from "../components/findings/DecisionPanel.js";
import { EvidenceSummary, TranscriptPanel } from "../components/findings/EvidencePanel.js";
import { isAccounting, isHistory, isIntegrity, isMetadata, isRevisions, useResource, words } from "../components/findings/model.js";
import { ReportSection } from "../components/findings/ReportSection.js";
import { RouteLink } from "../components/router.js";
import "../components/findings/style.css";
import { useWorkspace } from "./context.js";

/** One finding: exact evidence and the decision side by side, then the report job, revisions, preview, approval and download. */
export function FindingDetailPage({ findingId }: { findingId: string }) {
  const { navigate, refresh } = useWorkspace();
  const meta = useResource(() => requestJson(`/findings/${findingId}/metadata`, isMetadata), [findingId]);
  const runId = meta.data?.runId;
  const integrity = useResource(() => requestJson(`/findings/${findingId}/integrity`, isIntegrity), [findingId]);
  const history = useResource(() => requestJson(`/findings/${findingId}/history`, isHistory), [findingId]);
  const revisions = useResource(() => requestJson(`/findings/${findingId}/report-revisions`, isRevisions), [findingId]);
  const accounting = useResource(runId ? () => requestJson(`/runs/${runId}/report-jobs`, isAccounting) : null, [runId]);
  const changed = () => { void refresh(); void meta.reload(); void history.reload(); void revisions.reload(); void integrity.reload(); void accounting.reload(); };
  const jobState = meta.data?.report.job?.state;
  useEffect(() => {
    if (jobState !== "queued" && jobState !== "running") return;
    const timer = setInterval(() => { if (!document.hidden) { void meta.reload(); void revisions.reload(); void accounting.reload(); } }, 3000);
    return () => clearInterval(timer);
  }, [jobState, findingId]);
  const back = <RouteLink href="/findings" navigate={navigate}>← All findings</RouteLink>;
  if (!meta.data) return <div className="panel">{back}{meta.error ? <p role="alert" className="finding-warning">This finding could not load: {meta.error} <button type="button" onClick={() => void meta.reload()}>Retry</button></p> : <p role="status">Loading finding…</p>}</div>;
  const data = meta.data;
  return <section className="finding-detail" aria-label="Finding review">
    <div className="finding-head">{back}<h2>{data.narrative?.title ?? `${data.category ? words(data.category) : "Uncategorized"} finding ${findingId.slice(0, 8)}`}</h2>
      <button type="button" disabled={meta.loading} onClick={changed}>Refresh finding</button></div>
    {meta.error && <p role="alert" className="finding-warning">Finding could not refresh; the last loaded data is kept: {meta.error} <button type="button" onClick={() => void meta.reload()}>Retry</button></p>}
    <div className="finding-grid">
      <EvidenceSummary meta={data} integrity={integrity} navigate={navigate} />
      <DecisionPanel meta={data} integrity={integrity} history={history} onChanged={changed} />
      <TranscriptPanel meta={data} />
    </div>
    <ReportSection meta={data} integrity={integrity} revisions={revisions} accounting={accounting} onChanged={changed} />
  </section>;
}

import React, { useEffect, useState } from "react";
import { isRecordArray, requestJson } from "../api/client.js";
import { isListItem, isMetadata, useResource, words, type ListItem, type Metadata } from "../components/findings/model.js";
import { RouteLink } from "../components/router.js";
import "../components/findings/style.css";
import { useWorkspace } from "./context.js";

const reportStatus = (meta: Metadata) => meta.state !== "confirmed" ? "no report until confirmed" : meta.report.approvedRevisionId ? `approved revision ${meta.report.currentRevision}` : meta.report.currentRevision ? `draft revision ${meta.report.currentRevision}, not approved` : meta.report.job ? `job ${words(meta.report.job.state)}` : "no report job";
const states = [["all", "All states"], ["pending_review", "Pending review"], ["confirmed", "Confirmed"], ["rejected", "Rejected"]];

/** Finding list. Severity, category, completeness and report status come from each finding's metadata, loaded a few at a time. */
export function FindingsPage() {
  const { navigate, selectRun, model, refresh } = useWorkspace();
  const list = useResource(() => requestJson("/findings", isRecordArray(isListItem)), []);
  const [filter, setFilter] = useState("all");
  const [details, setDetails] = useState<Record<string, Metadata | "error">>({});
  const items: ListItem[] = list.data ?? [], shown = items.filter(item => filter === "all" || item.state === filter);
  useEffect(() => {
    let live = true;
    const queue = items.map(item => item.id).filter(id => !(id in details));
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        let value: Metadata | "error";
        try { value = await requestJson(`/findings/${id}/metadata`, isMetadata); } catch { value = "error"; }
        if (live) setDetails(current => ({ ...current, [id]: value }));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => { live = false; };
  }, [list.data]);
  return <div className="panel finding-list-panel">
    <div className="run-history-head"><div><div className="eyebrow">DECISION DESK</div><h2>Findings</h2></div>
      <label className="finding-filter">Filter by state<select value={filter} onChange={event => setFilter(event.target.value)}>{states.map(([value, label]) => <option key={value} value={value}>{label}{value === "all" ? ` (${items.length})` : ` (${items.filter(item => item.state === value).length})`}</option>)}</select></label>
      <button type="button" disabled={list.loading} onClick={() => { setDetails({}); void list.reload(); void refresh(); }}>Refresh findings</button></div>
    {list.loading && !list.data && <p role="status">Loading findings…</p>}
    {list.error && <p role="alert" className="finding-warning">Findings could not load{list.data ? "; the last list is kept" : ""}: {list.error} <button type="button" onClick={() => void list.reload()}>Retry</button></p>}
    {list.data && !items.length && <p className="empty">No findings yet. A finding appears when a run produces a reviewable or auto-confirmed candidate.</p>}
    {list.data && items.length > 0 && !shown.length && <p className="empty">No findings are in this state.</p>}
    {shown.length > 0 && <ul className="finding-list">{shown.map(item => {
      const meta = details[item.id];
      return <li key={item.id}>
        <div className="finding-row-head"><RouteLink className="finding-link" href={`/findings/${item.id}`} navigate={navigate}>{meta && meta !== "error" && meta.narrative ? meta.narrative.title : item.title ?? "Untitled finding"}</RouteLink>
          <button type="button" onClick={() => selectRun(item.runId, model, item.version)}>Inspect evidence</button></div>
        <div className="finding-chips">
          <span className={`finding-state state-${item.state}`}>{words(item.state)}</span>
          {meta === undefined ? <span role="status">Loading details…</span> : meta === "error" ? <span role="status" className="finding-warning">Details unavailable</span> : <>
            <span>Severity: {meta.severity?.level ?? "not assessed"}</span><span>{meta.category ? words(meta.category) : "no category"}</span>
            <span>{meta.target.name} / {meta.target.version ?? "unknown version"}</span>
            <span className={meta.completeness.status === "evidence_incomplete" ? "finding-warning" : undefined}>Evidence: {words(meta.completeness.status)}</span><span>Report: {reportStatus(meta)}</span></>}
        </div>
      </li>;
    })}</ul>}
  </div>;
}

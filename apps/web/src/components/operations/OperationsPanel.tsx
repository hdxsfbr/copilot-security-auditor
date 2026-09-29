import React, { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../../api/client.js";
import { RouteLink } from "../router.js";
import { diagnosticCopy, formatAge, isOperationsHealth, type OperationsHealth, type OperationsWorker } from "./model.js";
import "./style.css";

const REFRESH_MS = 10_000;

// Polls only while the Overview route is active and the tab is visible. The
// last valid sample is retained across failures.
function useOperationsHealth(active: boolean) {
  const [sample, setSample] = useState<OperationsHealth | null>(null);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await requestJson("/operations/health", isOperationsHealth);
      if (sequence.current === request) { setSample(next); setFailed(false); }
    } catch { if (sequence.current === request) setFailed(true); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { sequence.current++; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, load]);
  return { sample, failed, retry: () => void load() };
}

const workerState = (worker: OperationsWorker) => worker.state === "idle" ? "Idle" : worker.state === "busy" ? "Busy" : "No recent heartbeat";
const time = (value: string) => new Date(value).toLocaleTimeString();

export function OperationsPanel({ active, navigate }: { active: boolean; navigate: (path: string) => void }) {
  const { sample, failed, retry } = useOperationsHealth(active);
  const summary = sample?.workerSummary;
  return <section className="panel operations-panel" aria-labelledby="operations-heading">
    <div className="eyebrow">OPERATIONS</div><h2 id="operations-heading">Worker and queue health</h2>
    {!sample && !failed && <p role="status">Checking worker and queue health…</p>}
    {failed && <div className="operations-error" role="alert">{sample ? `Worker and queue health could not refresh; showing the sample checked at ${time(sample.checkedAt)}.` : "Worker and queue health is unavailable. The API or database may be down."} <button type="button" onClick={retry}>Retry</button></div>}
    {sample && summary && <>
      <p className={`operations-verdict ${sample.status}`} role="status"><strong>{sample.status === "attention" ? "Needs attention" : "Normal"}</strong>{sample.status === "attention" ? " — see the actions below." : sample.diagnostics.length ? " — see the note below." : " — a worker is reporting and no queue or lease problem is visible."}</p>
      {sample.diagnostics.length > 0 && <ul className="operations-diagnostics" aria-label="Diagnostics">{sample.diagnostics.map(item => { const copy = diagnosticCopy(item.code, sample.policy);
        return <li key={item.code} className={item.level}><strong>{item.level === "warning" ? "Warning" : "Note"}: {copy.title}</strong><span>{copy.action}</span></li>; })}</ul>}
      <dl className="operations-facts">
        <div><dt>Workers</dt><dd>{summary.state === "none_registered" ? "None registered" : summary.state === "no_recent_heartbeat" ? "No recent heartbeat" : `${summary.freshCount} reporting (${summary.idleCount} idle, ${summary.busyCount} busy)`}</dd></div>
        <div><dt>Queue</dt><dd>{sample.queue.queuedCount} queued{sample.queue.oldestQueuedAgeSeconds === null ? "" : `, oldest waiting ${formatAge(sample.queue.oldestQueuedAgeSeconds)}`}</dd></div>
        <div><dt>Run leases</dt><dd>{sample.leases.activeCount} active, {sample.leases.expiredCount} expired</dd></div>
      </dl>
      {sample.workers.length > 0 && <><h3>Worker processes</h3><ul className="operations-workers">{sample.workers.map(worker => <li key={worker.id}>
        <strong>Worker {worker.id.slice(0, 8)}</strong>: {workerState(worker)} · heartbeat {formatAge(worker.heartbeatAgeSeconds)} ago · started {time(worker.startedAt)}
        {worker.state === "busy" && worker.activeRunId && <> · <RouteLink href={`/runs/${worker.activeRunId}`} navigate={navigate}>Inspect its run</RouteLink></>}
        {worker.diagnosticCode && <> · last cycle: {diagnosticCopy(worker.diagnosticCode, sample.policy).title}</>}</li>)}</ul></>}
      <p className="hint operations-note">Execution capacity is one evaluation per reporting worker process. Target reservations are separate: each target holds at most one queued or running evaluation, shown under Saved scope. Heartbeats are sent every {sample.policy.heartbeatIntervalSeconds} s and count as recent for {sample.policy.freshSeconds} s. A missing heartbeat does not prove the worker stopped.</p>
      <div className="operations-foot"><span>Checked {time(sample.checkedAt)}. Refreshes every {REFRESH_MS / 1000} s while this page is open.</span><button type="button" onClick={retry}>Refresh now</button></div>
    </>}
  </section>;
}

import React from "react";
import { RouteLink } from "../components/router.js";
import { useWorkspace } from "./context.js";

export function OverviewPage() {
  const { targets, cases, findings, run, navigate } = useWorkspace();
  const pending = findings.filter(finding => finding.state === "pending_review").length;
  const reserved = targets.filter(target => target.activeRunId);
  return <div className="overview-grid">
    <section className="panel"><div className="eyebrow">CURRENT WORK</div><h2>Run and review</h2>
      <p>{run ? `${run.status} / ${run.outcome ?? "awaiting result"}` : "No run selected in this workspace."}</p>
      {run && <RouteLink className="task-link" href={`/runs/${run.id}`} navigate={navigate}>Inspect current run</RouteLink>}
      <p>{pending} finding{pending === 1 ? "" : "s"} awaiting review.</p>
      <RouteLink className="task-link" href="/findings" navigate={navigate}>Open findings</RouteLink>
    </section>
    <section className="panel"><div className="eyebrow">READY TO TEST</div><h2>Saved scope</h2>
      <p>{targets.length} authorized target{targets.length === 1 ? "" : "s"} · {cases.length} saved case{cases.length === 1 ? "" : "s"}</p>
      <p>{reserved.length ? `${reserved.length} target reservation${reserved.length === 1 ? "" : "s"} active.` : "No target reservation shown."}</p>
      {reserved.map(target => <p key={target.id}><RouteLink href={`/runs/${target.activeRunId}`} navigate={navigate}>Inspect {target.name}'s active run</RouteLink></p>)}
      <RouteLink className="task-link" href="/runs/new" navigate={navigate}>Launch an evaluation</RouteLink>
    </section>
  </div>;
}

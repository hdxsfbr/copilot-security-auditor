import React from "react";
import { useWorkspace } from "./context.js";

export function RegressionsPage() {
  const { regressions, findings, selectRegression } = useWorkspace();
  return <section className="panel" aria-labelledby="regressions-heading">
    <div className="eyebrow">CONFIRMED DEFINITIONS</div>
    <h2 id="regressions-heading">Regressions</h2>
    {regressions.length ? regressions.map(regression => <article className="review-item" key={regression.id}>
      <strong>{regression.definition.title}</strong>
      <p>Baseline {regression.version ?? "unknown"} · original run {regression.sourceRunId.slice(0, 8)}</p>
      <p>{regression.replays.length ? regression.replays.map(replay => `${replay.version ?? "unknown"}: ${replay.outcome}`).join(" · ") : "No replay on this target yet"}</p>
      {findings.some(finding => finding.runId === regression.sourceRunId) &&
        <button type="button" onClick={() => void selectRegression(regression.id, regression.sourceRunId)}>Select for replay</button>}
    </article>) : <p className="hint">No confirmed regression definitions yet.</p>}
  </section>;
}

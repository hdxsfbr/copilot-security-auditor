import React from "react";
import { useWorkspace } from "./context.js";

export function FindingsPage() {
  const { refresh, findings, model, actOnFinding, exported, selectRun } = useWorkspace();
  return (
          <div className="panel">
            <div className="eyebrow">DECISION DESK</div>
            <h2>Findings & review</h2>
            <button onClick={() => void refresh()}>Refresh decisions</button>
            {findings.length ? (
              findings.map((f) => (
                <article className="review-item" key={f.id}>
                  <strong>{f.title}</strong>
                  <p>
                    {f.state} / {f.decisionRoute ?? "awaiting operator"} ·{" "}
                    {f.version ?? "unknown version"}
                  </p>
                  <button onClick={() => selectRun(f.runId, model, f.version)}>
                    Inspect evidence
                  </button>{" "}
                  {f.state === "pending_review" && (
                    <>
                      <button
                        onClick={() => void actOnFinding(f.id, "confirm")}
                      >
                        Confirm
                      </button>{" "}
                      <button onClick={() => void actOnFinding(f.id, "reject")}>
                        Reject
                      </button>
                    </>
                  )}{" "}
                  {f.state === "confirmed" && (
                    <button onClick={() => void actOnFinding(f.id, "approve")}>
                      {f.exportApprovedAt
                        ? "View redacted export"
                        : "Approve redacted export"}
                    </button>
                  )}
                </article>
              ))
            ) : (
              <p className="hint">No reviewable observations yet.</p>
            )}
            {exported && <pre className="export-preview">{exported}</pre>}
          </div>

  );
}

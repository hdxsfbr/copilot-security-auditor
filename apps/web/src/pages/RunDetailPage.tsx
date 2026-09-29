import React from "react";
import { useWorkspace } from "./context.js";

export function RunDetailPage() {
  const { run, events, runError, pollRun, cases } = useWorkspace();
  return (
        <section className="evidence">
          <div className="evidence-top">
            <div>
              <div className="eyebrow">OBSERVATION STREAM</div>
              <h2>Run evidence</h2>
            </div>
            <div className="status">
              {run
                ? `${run.status} / ${run.outcome ?? "awaiting result"}`
                : "NO RUN SELECTED"}
            </div>
          </div>
          {run && (
            <div className="run-meta">
              RUN {run.id} &nbsp;·&nbsp; TARGET VERSION{" "}
              {run.version ?? "awaiting handshake"} &nbsp;·&nbsp; JUDGE{" "}
              {run.modelSnapshot?.roles.judge.provider ?? "ollama"} / {run.model}
            </div>
          )}
          {runError && <p role="alert">Run progress could not refresh; the last saved evidence is still shown. {runError} <button type="button" onClick={() => void pollRun()}>Retry progress</button></p>}
          {cases
            .find((c) => c.id === run?.caseId)
            ?.actions.map((action, i) =>
              action.artifactId && action.documentType ? (
                <a
                  key={i}
                  href={`/api/cases/${run?.caseId}/artifacts/${action.artifactId}?documentType=${action.documentType}`}
                >
                  Download restricted synthetic PDF for step {i + 1}
                </a>
              ) : null,
            )}
          {events.length ? (
            <ol className="timeline">
              {events.map((item) => (
                <li key={item.id}>
                  <span className="step">
                    {String(item.id).padStart(3, "0")}
                  </span>
                  <div>
                    <div className="event-head">
                      <b>
                        {item.event.agent} / {item.event.kind}
                      </b>
                      <time>
                        {new Date(item.createdAt).toLocaleTimeString()}
                      </time>
                    </div>
                    <pre>{JSON.stringify(item.event.detail, null, 2)}</pre>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty">
              Once a case starts, chart setup, target turns, deterministic
              checks and the independent verdict appear here in order.
            </p>
          )}
        </section>

  );
}

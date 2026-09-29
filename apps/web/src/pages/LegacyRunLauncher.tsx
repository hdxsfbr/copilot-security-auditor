import React from "react";
import { useWorkspace } from "./context.js";

export function LegacyRunLauncher() {
  const { refresh, targets, targetId, setTargetId, caseId, setCaseId, cases, model, ollamaUrl, setModel, setOllamaUrl, configEdited, startSelected } = useWorkspace();
  return (
          <section className="panel run-panel">
            <h2>
              <span>03</span> Launch evaluation
            </h2>
            <p className="hint">
              Select a saved synthetic case or author your own. Nothing runs
              until you press Start. The chart-context starter checks the
              Co-Pilot, not OpenEMR permissions; it substitutes the other saved
              external patient ID at dispatch.
            </p>
            <button
              type="button"
              onClick={() => {
                void refresh();
              }}
              aria-label="Reload saved targets"
            >
              Reload saved targets ({targets.length})
            </button>
            <form onSubmit={(e) => { e.preventDefault(); void startSelected(); }}>
              <label>
                Saved authorized target
                <select
                  required
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">Select a saved target</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} - {t.baseUrl} ({t.id.slice(0, 8)})
                    </option>
                  ))}
                </select>
              </label>
              {!targets.length && (
                <p className="hint">
                  No targets saved yet. Create one in section 01, then select it
                  here.
                </p>
              )}
              <label>
                Selected case
                <select
                  required
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                >
                  <option value="">Select case</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id === "c0000000-0000-4000-8000-000000000002"
                        ? `Legacy (role isolation): ${c.title}`
                        : c.title}
                    </option>
                  ))}
                </select>
              </label>
              {cases
                .filter((c) => c.id === caseId)
                .map((c) => (
                  <div className="case-preview" key={c.id}>
                    <strong>
                      {c.category?.replaceAll("_", " ") ?? "prompt injection"} /
                      user {c.user}
                    </strong>
                    <p>Expected: {c.expectedSafeBehavior}</p>
                    {c.actions.map((action, i) => (
                      <p key={i}>
                        Step {i + 1} ({action.kind}): {action.message}
                      </p>
                    ))}
                  </div>
                ))}
              <label>
                Ollama endpoint
                <input
                  type="url"
                  required
                  value={ollamaUrl}
                  onChange={(e) => { configEdited.current.ollamaUrl = true; setOllamaUrl(e.target.value); }}
                />
              </label>
              <label>
                Installed model
                <input
                  required
                  placeholder="e.g. llama3.2"
                  value={model}
                  onChange={(e) => { configEdited.current.model = true; setModel(e.target.value); }}
                />
              </label>
              <button className="primary">Start selected run →</button>
            </form>
          </section>

  );
}

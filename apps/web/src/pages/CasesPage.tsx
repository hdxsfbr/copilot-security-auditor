import React from "react";
import { useWorkspace } from "./context.js";

export function CasesPage() {
  const { testCase, setTestCase, pdf, setPdf, documentType, setDocumentType, submit, saveCase } = useWorkspace();
  return (
          <section className="panel">
            <h2>
              <span>02</span> Case definition
            </h2>
            <p className="hint">
              Define a trust boundary, a scoped check and up to one synthetic
              PDF. Cross-patient cases test whether the Co-Pilot stays within
              the selected chart context.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit(saveCase);
              }}
            >
              <label>
                Case title
                <input
                  required
                  value={testCase.title}
                  onChange={(e) =>
                    setTestCase({ ...testCase, title: e.target.value })
                  }
                />
              </label>
              <label>
                Category
                <select
                  value={testCase.category}
                  onChange={(e) =>
                    setTestCase({ ...testCase, category: e.target.value })
                  }
                >
                  <option value="prompt_injection">Prompt injection</option>
                  <option value="cross_patient">Cross-patient access</option>
                  <option value="unintended_tool_action">
                    Unintended tool action
                  </option>
                </select>
              </label>
              <label>
                Expected safe behavior
                <textarea
                  required
                  value={testCase.expectedSafeBehavior}
                  onChange={(e) =>
                    setTestCase({
                      ...testCase,
                      expectedSafeBehavior: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Test message
                <textarea
                  required
                  maxLength={1000}
                  value={testCase.message}
                  onChange={(e) =>
                    setTestCase({ ...testCase, message: e.target.value })
                  }
                />
              </label>
              <label>
                Assigned user
                <select
                  value={testCase.user}
                  onChange={(e) =>
                    setTestCase({ ...testCase, user: e.target.value })
                  }
                >
                  <option>A</option>
                  <option>B</option>
                </select>
              </label>
              <label>
                Deterministic check
                <select
                  value={testCase.check}
                  onChange={(e) =>
                    setTestCase({ ...testCase, check: e.target.value })
                  }
                >
                  <option value="none">Judge only</option>
                  <option value="forbidden_patient_disclosure">
                    Other patient's external ID disclosed
                  </option>
                  <option value="required_source_citation">
                    Source citation required
                  </option>
                  <option value="forbidden_tool_effect">
                    Forbidden visible effect
                  </option>
                </select>
              </label>
              {testCase.check === "forbidden_tool_effect" && (
                <label>
                  Visible forbidden effect
                  <input
                    required
                    value={testCase.effect}
                    onChange={(e) =>
                      setTestCase({ ...testCase, effect: e.target.value })
                    }
                  />
                </label>
              )}
              <label>
                Synthetic PDF (optional)
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => setPdf(e.target.files?.[0] ?? null)}
                />
              </label>
              {pdf && (
                <label>
                  Document workflow
                  <select
                    value={documentType}
                    onChange={(e) =>
                      setDocumentType(e.target.value as typeof documentType)
                    }
                  >
                    <option value="lab_pdf">Lab PDF (20 MB / 20 pages)</option>
                    <option value="intake_form">
                      Intake form (10 MB / 10 pages)
                    </option>
                  </select>
                </label>
              )}
              <button>Save case</button>
            </form>
          </section>

  );
}

# Demo video script (target 4:40, limit 5:00)

Shot list for the PRD demo: work completed, key decisions, and the platform running live attacks against the deployed target (`https://openemr-137-184-4-22.sslip.io`, `docs/COPILOT_FEATURE.md` section 2). Bracketed items are operator placeholders; never fill a finding from memory or from fixtures.

## Before recording

- Synthetic data only. Keep `.env`, passwords and cookies off screen.
- Pre-launch the live run; a case can take over a minute (turn deadline 90 s). Record the launch, cut to the finished run, and caption it "time-compressed".
- Suggested live run: one selected current-chart isolation case with a local Judge, then one adaptive run (`maxCases` 3, three categories).
- A paid Judge must pass preflight and the cap must exceed one reservation. The UI default cap of 0.25 USD is below a `mistral-medium-3-5` reservation (about 0.40 USD); see `cost-and-scale.md` section 3.

## Dependencies on work landing tonight

| Feature | Segment | If not merged |
| --- | --- | --- |
| Report drafting and review (F00-F02) | 2, 7 | Show the current Findings page (confirm, reject, approve redacted export); say Documentation is designed but not yet invoked. |
| Run composer (U04) | 4 | Use the current Launch page: "Role models and spend" plus the adaptive form. |
| Coverage UI (V02) | 8 | Show the current Coverage page (outcome counts per category). |
| Operations health (O01) | 9 | Omit; say worker and queue health signals are planned. |

Not landing tonight, so describe as planned: regression suites and fixed/resurfaced states (G01, G02), adaptive stagnation stop (A17). Already on `main`: routed shell, case workspace, run history, structured run evidence.

## Shot list

### 1. 0:00-0:25 Problem framing

**On screen:** `docs/COPILOT_FEATURE.md` overview or a chart with the Co-Pilot panel.

- The Co-Pilot answers from the open patient's chart, reads PDFs, cites records, and promises to be read-only.
- Its promise: text in chat, notes or PDFs cannot change the patient, scope, tools or write boundary.
- The auditor tests that repeatedly across target versions: prompt injection, chart-context isolation, unintended tool actions.

### 2. 0:25-0:55 Architecture and trust boundaries

**On screen:** the `ARCHITECTURE.md` diagram, then the role table.

- Four roles, separate authority: Orchestrator selects bounded work; Red Team proposes one to three typed actions; Judge proposes a cited verdict; Documentation drafts only from confirmed evidence. [F00-F01: say "landing" if absent.]
- A proposal is data until schema and policy admit it. The worker, not a model, owns credentials, chart selection, tickets and replay.
- The Judge only proposes. A deterministic gate requires complete observations, resolvable evidence references, a quote from the cited response that is not a prompt echo, and no material uncertainty.

### 3. 0:55-1:20 UI tour

**On screen:** Overview, Targets, Cases workspace.

- Targets: synthetic identities (passwords never returned), host allowlist, two distinct chart assignments.
- Cases: versioned definitions with category, OWASP mapping, severity rationale, at most three actions. Footer: "CONFIRMED ≠ PUBLISHED · INCOMPLETE ≠ SAFE".

### 4. 1:20-1:45 Composing a run

**On screen:** Launch page, "Role models and spend" [U04 composer if merged].

- Pick target and case; assign a model per role: local `qwen3-coder:30b` for Orchestrator and Red Team, local or paid Judge.
- Bounds: cases, minutes, per-run paid cap. Nothing dispatches until Start, and one run is active per target.

### 5. 1:45-2:30 Live run against the deployed target

**On screen:** Runs, then run detail during execution (time-compressed).

- Evidence stream: session open with target version, distinct-chart check, each prompt and response, deterministic checks, model usage rows with tokens and latency.
- Adaptive sequence: Orchestrator picks a case, Red Team proposes actions, the boundary admits or rejects them, the target answers.

### 6. 2:30-3:05 Evidence-grounded verdict

**On screen:** structured evidence for `[RUN-ID / CASE]`: action, response, checks, Judge claim and quote, policy gate.

- Outcome: `[safe | pending_review | inconclusive | incomplete]`. Finding: `[title, category, severity, what the response said]`.
- Quotes are checked against the cited response. Repeating an ID is not disclosure; an incomplete or truncated turn never becomes safe.

### 7. 3:05-3:35 Human review and report

**On screen:** Findings: evidence beside verdict, decision, export approval [F02 preview if merged].

- Uncertain candidates wait for an operator to confirm or reject; confirming creates a replayable definition.
- Publishing a redacted report is a separate approval. `[F01/F02: draft from confirmed evidence, exact-revision approval]`.

### 8. 3:35-4:00 Regression and coverage

**On screen:** Regressions, "Select for replay"; Coverage [V02 scoped view if merged].

- Replay reuses the exact validated actions. Suites and fixed/resurfaced/unknown states are planned, not shown.
- Coverage separates executed from untested cases, scoped by target and version.

### 9. 4:00-4:20 Cost controls

**On screen:** run usage rows; `cost-and-scale.md` section 5 table [O01 health if merged].

- Each paid call reserves the full context-window price first; a per-run cap, an unresolved-charge hold and no model fallback bound spend. Local Ollama calls carry no dollar price.
- Target-side inference dominates the projection. Actual development spend: `[operator figure]`.

### 10. 4:20-4:40 Honest limits and close

**On screen:** `KEY_METRICS.md` or the open-items list.

- LAN-only, no app login; auto-confirm is uncalibrated until Judge calibration lands; fixture passes are not live findings.
- Open: 100-case live baseline, independent peer integration, `[number]` confirmed live findings.
- Close on the repository and deployed-target links.

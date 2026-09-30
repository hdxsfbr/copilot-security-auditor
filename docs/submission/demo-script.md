# Demo video script (OpenMontage)

A scene-by-scene script for an automated recorder that drives the browser, records the screen and narrates. Target length **about 5:00** (approved range 4:00–6:30). Each scene gives the exact actions (UI labels are quoted exactly as they appear) and the narration to speak. Everything shown is synthetic.

## Environment (check before recording; do not narrate)

- **App:** `http://10.0.0.32:3000` (Clinical Auditor, no login). The recorder must run on a machine that can reach this LAN address.
- **Browser:** 1440×900 or larger, zoom 100%, light theme.
- **State:** "Local Co-Pilot" (`http://10.0.0.32:8300`, target version 0.8.0) and "Public Co-Pilot" (`https://openemr-137-184-4-22.sslip.io/`, target version 0.8.0) are configured. Seeded local runs and one completed adaptive run remain available. The public target has completed selected runs for the 10 starter cases; two rows match the direct current-chart isolation case in scene 11 (both `safe`), and either works. Both targets must be idle; on **Overview**, "Worker and queue health" reads "Normal".
- **Architecture image:** `docs/submission/assets/architecture.png` in this repository (the GitLab project is private, so do not navigate to GitLab). Open it as a local file.
- **Do not show:** any `.env` file or terminal; do not type into the **Password** field on **Targets**.
- **Live-run timing:** a single-case run takes about 20 seconds. If the recorder cannot wait, cut and caption "time-compressed".
- **Never claim a discovered vulnerability.** This pass found none; the script says so.

## Scenes

### 1 · 0:00–0:25 · The problem

**Actions:** open `http://10.0.0.32:3000/` (**Overview**). Hover the left navigation from **Overview** down to **Schedules**.

**Narration:**
> OpenEMR's Clinical Co-Pilot answers questions from the open patient's chart, reads uploaded PDFs, and promises to stay read-only and inside that one chart. This is the Clinical Auditor: a multi-agent system that attacks that assistant continuously, judges every answer against evidence, and turns what it finds into reviewable reports and repeatable regression tests.

### 2 · 0:25–0:55 · Architecture and trust boundaries

**Actions:** open `docs/submission/assets/architecture.png`. Start at the top ("Operator") and scroll slowly to the bottom ("Policy gates (deterministic)"). Pause on the "Adaptive runs only" box, then on "Judge model" and "Policy gates".

**Narration:**
> Four agent roles have separate authority. The Orchestrator picks what to test next from coverage gaps and regression history. The Red Team writes the attack messages. The Judge proposes a verdict with a verbatim quote. The Documentation role drafts reports only for confirmed findings. No model holds credentials or chooses endpoints: every proposal passes a deterministic admission gate, and the Judge's verdict passes deterministic policy gates before anything counts as safe or as a finding.

### 3 · 0:55–1:16 · Targets and cases

**Actions:** click **Targets**. In "Target to configure", select "Local Co-Pilot - http://10.0.0.32:8300". Pause on the two test users (usernames and "External patient ID (pubpid)"). Click **Cases**. Click "Starter: current-chart isolation / multi-turn". Scroll to "Rubric and threat mapping" (subcategory, OWASP mappings, severity).

**Narration:**
> The target is a synthetic OpenEMR deployment with two test clinicians, each bound to a different synthetic patient. Passwords are stored encrypted and never returned to the browser. Test cases are versioned: each records its attack steps, the safe behavior it expects, OWASP mappings and a severity rationale.

### 4 · 1:16–1:42 · Launching a live attack

**Actions:** click **Launch**. In "Saved authorized target" select "Local Co-Pilot - http://10.0.0.32:8300". Under "Run mode" choose **Single case**. In "Selected case" choose "Starter: current-chart isolation / direct". Leave "Judge provider" as "Host Ollama (local)" (model `qwen3-coder:30b`). Click **Check availability**; pause on "$0 paid reservation; local inference unverified." Click **Start run**.

**Narration:**
> An operator composes one bounded run: the target, a case, and a model for each active role. Here the Judge runs on a local model, so the paid reservation is zero. Preflight checks model availability before anything is sent. When I start the run, the platform attacks the live target: it logs in as the synthetic clinician, opens patient A's chart, and asks for another patient's lab results.

### 5 · 1:42–2:16 · Evidence from the live run

**Actions:** stay on the run page that opened after **Start run**. Wait until the status reads "FINISHED". Point at the header (outcome, target "Local Co-Pilot / 0.8.0", Judge model). Scroll through "Turns and checks": the "target / turn" event (chat message and visible response), "check / deterministic", the Judge verdict and the policy event. Then scroll up to "Measured model usage".

**Narration:**
> Every step is recorded as structured evidence: the session and target version, the exact message sent, the assistant's visible reply, and the deterministic checks. In this run the reply did not reveal anything from the other chart, and the outcome is labelled only as far as that evidence supports. The Judge proposes a verdict with a quote, and the policy gates check that the quote really appears in the cited reply and is not just an echo of the prompt. Model usage is metered per call: tokens, latency and cost.

### 6 · 2:16–2:43 · Adaptive exploration

**Actions:** click **Runs**. Click the entry "Local Co-Pilot adaptive · finished / inconclusive". Pause on "Adaptive progress" (three categories) and "Measured model usage" (orchestrator, redTeam, judge rows). Click **Case 2: unintended tool action** and scroll to its chat message.

**Narration:**
> In adaptive mode the agents work as a loop. The Orchestrator ranks seeds by coverage gaps, regressions and severity; the Red Team mutates the seed attack, here pressuring the assistant to place a lab order; and the Judge assesses each case. Stored transcripts are scrubbed of credentials, which is why some words appear as "redacted". Categories that stop producing signal are parked, so spend goes where it can still find something.

### 7 · 2:43–3:09 · Findings and human review

**Actions:** click **Findings**. Pause on "Filter by state" (all counts are zero).

**Narration:**
> Nothing here is auto-published. A suspected violation waits for a human, who confirms or rejects it with a typed rationale next to the evidence. Confirmed findings can get a drafted, redacted report that must be approved at an exact revision before download. In this first live pass the Co-Pilot held, so there are no confirmed findings, and we report that honestly.

### 8 · 3:09–3:35 · Coverage and regressions

**Actions:** click **Coverage**. Pause on the table "Local Co-Pilot · version 0.8.0". Tick "Show individual cases" and scroll the table (gap chips, safe-rate numerator/denominator). Click **Regressions**. Pause on "Regression state", "Validate a new version" and "Version-change trigger" (do not click "Turn on for Local Co-Pilot…").

**Narration:**
> Coverage is scoped to one target version at a time and keeps untested, blocked and inconclusive separate, so an unknown result never counts as safe. Every confirmed attack becomes a regression identity; suites replay them against new target versions and label each one recurring, fixed, resurfaced or unknown. A version-change trigger can queue that suite automatically, without ever deploying anything.

### 9 · 3:35–3:49 · Operations and cost

**Actions:** click **Overview**. Pause on "Worker and queue health" and "Unresolved spend".

**Narration:**
> Operators can see worker health and queue age at a glance, and every paid call is reserved before it is sent, capped per run and reconcilable afterwards. This whole demo ran on local models, at zero model spend.

### 10 · 3:49–4:18 · Limits and close

**Actions:** stay on **Overview**. Optionally show `docs/submission/README.md` from the repository as a local file.

**Narration:**
> The limits are stated plainly. The original full pass used a local copy. A separate public example follows. It has found no confirmed vulnerability yet, and independent peer integration and a 100-case live load test are still to come. The code, evidence and cost analysis are in the repository's submission index.

### 11 · 4:19–4:58 · A separate example on the public deployment

**Actions:** from **Overview**, click **Runs**. Open a completed row for "Public Co-Pilot" and "Starter: current-chart isolation / direct" with outcome **safe** (either matching row works). Confirm the header reads "FINISHED / SAFE" and shows "Public Co-Pilot / 0.8.0". Pause on the target/turn reply, then the deterministic check and policy event. Do not expand "Raw event JSON". End on **Overview**.

**Narration:**
> As a separate example, this same bounded case ran against the public Co-Pilot deployment, version zero point eight point zero, using synthetic accounts and a local model. The visible reply did not provide the requested lab results, so the policy gave this one observed interaction a scoped safe judgment. The system did not independently verify underlying chart access, and this single result is not a broader security claim about the service.

## Operator notes (not for narration)

- Scene 4 creates a new live run against the local target using local models only. Scene 6 relies on the existing adaptive run shown as "finished / inconclusive"; ignore the older "finished / incomplete" adaptive entry. Scene 11 shows the completed public-target run recorded for the same selected case; it does not start another run.
- If the recorder cannot reach the LAN address, record the app locally instead; the narration stays the same.
- Evidence behind the narration: live results `evals/results/live/2026-09-29/README.md`; architecture `ARCHITECTURE.md`; cost `docs/submission/cost-and-scale.md`; simulated triage (review and reporting quality, clearly labelled simulated) `docs/submission/triage.md`.

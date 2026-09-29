---
task: multi-model-llm-integration-platform-gv6ruh
type: design-prd
repo: copilot-security-auditor
branch: multi-model-llm-integration-platform-gv6ruh
sha: 4f9c267db4bef64ada3816b9ba978753fc3f575a
---

# Clinical Co-Pilot Adversarial Evaluation Platform

### Problem to Solve

Per the AgentForge project brief summarized in the research, teams need to know whether a live Clinical Co-Pilot safely handles adversarial inputs, protects patient information, and stays within authorized actions. Today this greenfield project has no repeatable way to generate attacks against an operator-supplied live Co-Pilot, independently judge observed behavior, turn confirmed failures into actionable findings, and check that fixes hold. The operator will run the Co-Pilot and OpenEMR separately, either in local Docker or on a DigitalOcean deployment, and provide the target URL and credentials. The task brief also calls for choice between OpenRouter and local Ollama models, so evaluations must not depend on one model source or force every run onto metered API billing.

### What does business success look like, and how can we measure it?

#### A live evaluation produces evidence a reviewer can act on

The team can run adversarial cases against a live Clinical Co-Pilot, inspect an independent judgment alongside the observed behavior, and reproduce each confirmed failure from its finding. Measure the share of cases with a complete observation and verdict, and the share of confirmed findings that a reviewer can reproduce; track inconclusive runs separately rather than counting them as safe behavior.

#### Fixes stay fixed as coverage grows

Confirmed failures become repeatable checks that can be rerun after a change. Track regression outcomes across Co-Pilot versions and coverage by threat category, including gaps, so the team can see both whether a fix holds and what remains untested. The project's initial three-category live evaluation described in the AgentForge brief provides the first coverage checkpoint, not a claim of comprehensive safety.

#### Model flexibility remains practical to operate

Operators can see which model source each role used and its usage or estimated cost where available. Track completion rate and cost per run by source, distinguishing paid OpenRouter charges from local Ollama inference rather than assigning a fictitious dollar price to local runs. These signals help decide whether broader or repeated testing is sustainable.

### Proposed Solution

Build an adversarial evaluation platform with an operator control plane that runs against a live Clinical Co-Pilot supplied and operated by the user, rather than building the Co-Pilot or OpenEMR here. An operator selects a local Docker-backed or internet-accessible DigitalOcean target and supplies its URL and credentials; the platform offers the same tests and evidence workflow for either target. Operators can start runs manually or schedule recurring runs, replay selected cases or run adaptive adversarial exploration within chosen bounds, and assign a model source to each agent role. The control plane also exposes run progress, findings needing review, coverage, regressions, and cost. Both run paths record live responses and independent judgments; confidently supported failures become confirmed regressions without mandatory review, while uncertain ones are escalated.

### Alternative Solutions Considered

- Building a Co-Pilot and OpenEMR here would duplicate the operator's existing toy instances and shift attention away from auditing live behavior.
- A single-model, API-only runner would make independent role choices and local, unmetered inference unavailable.
- A CLI-only report generator would not give the operator a place to schedule evaluations, manage limits, or confirm findings.
- Confirming every finding manually would make high-confidence evaluations wait unnecessarily; uncertain or contradictory evidence instead goes to human review, and report publication remains operator-approved.

### Solution Details

#### The operator provides the live target

The operator runs and maintains the Clinical Co-Pilot and OpenEMR separately. For an evaluation, they point the platform at either their local Docker-hosted Co-Pilot or their internet-accessible DigitalOcean instance and provide credentials for at least two authorized test users with distinct patient access. Both are authorized toy instances, so hosting location alone does not change which adversarial tests are available; DigitalOcean is not treated as a restricted clinical production environment. Evidence identifies which target and Co-Pilot version were tested so results from local and remote runs are not conflated. The platform does not provision either application or assume that credentials are bundled with its project files. Before cross-patient testing, a pre-run check verifies that each test identity can reach its own records and cannot normally reach the other's. If this boundary cannot be established, cross-patient cases are marked blocked with the reason while eligible cases in other categories continue; blocked cases are never counted as passes or failures.

#### Operators choose repeatability or exploration per run

In a selected-case run, the operator chooses existing cases to exercise and compare against earlier outcomes. In an adaptive run, the operator chooses threat categories and sets maximum case count and elapsed time; when OpenRouter is used, the operator also sets a spending cap. Adversarial agents generate and vary attacks in response to live observations until any applicable limit is reached or the operator stops the run. Ollama-only runs still obey case and time limits. Both modes keep the test sequence, observed behavior, judgment, target identity, and resource usage together as reviewable evidence; stopping at a limit leaves unfinished cases visibly incomplete, never passed. An adaptive finding can subsequently become a selected regression case.

#### The control plane supports manual and recurring runs

The first release has an operator-facing control plane, not just a read-only dashboard. Operators configure a target and credentials, assign models to agent roles, define cases or exploration limits, start and stop runs, and schedule recurring evaluations in either selected-case or bounded adaptive mode. A schedule makes its target, mode, run definition, cadence, and next run visible; operators can pause it without deleting its history. A selected-case schedule repeats the chosen cases to catch regressions; an adaptive schedule explores within its case, time, and applicable spending limits on each occurrence. At most one run can be active against a target, whether started manually or by any schedule. If a scheduled occurrence conflicts, skip it and record the scheduled time and reason; subsequent occurrences remain scheduled. A manual start against a busy target is not launched, and the control plane explains which active run must finish first. Runs against distinct targets can proceed independently. Run views show live progress and agent sequence, while review and overview views show candidates requiring review, auto-confirmed findings, per-category coverage, regressions by target version, and usage or costs by model source. Schedule-triggered runs use the same evidence and confidence-based confirmation policy as manual runs.

If the target is unreachable or a test user cannot sign in when a scheduled run starts, mark that occurrence blocked, show the reason to the operator, and wait for the next scheduled occurrence. Do not repeatedly retry the blocked occurrence or classify the target failure as a successful or failed security case. A manual run can be started after access is restored.

```task-artifact
.humanlayer/tasks/multi-model-llm-integration-platform-gv6ruh/mockup-operator-control-plane.html
```

#### The first live evaluation covers three distinct trust boundaries

The initial case set and adaptive exploration cover prompt injection (including direct and indirect instructions), patient-data leakage or cross-patient access failures, and unintended tool actions. Cross-patient cases use two test-user identities whose allowed patient records differ; they check whether a user can obtain records outside their own access. Each case names the boundary it challenges and the expected safe behavior before a Judge considers the observed result. Report case counts and outcomes separately for each category, with untested subareas shown as coverage gaps rather than implied passes. Additional threat categories from the AgentForge brief can follow after these three have live evidence.

#### Tests enter through the user-facing Co-Pilot workflow

At launch, the auditor interacts with the Co-Pilot as an authorized user would, including multi-turn chat and any retrieval or tool behavior that user interaction triggers. The operator-supplied interface uses an OpenEMR login cookie, an open patient chart, a module session and conversation, and a short-lived one-use ticket per agent call; the auditor should use this documented API path rather than requiring browser token capture. It records the user-visible conversation and observable effects needed to judge the case. Document uploads that feed a chat turn are in scope for indirect injection. Direct testing of administrative controls or integration interfaces is not part of the first evaluation; an indirect-injection case is in scope when untrusted content is encountered through a user-facing workflow.

#### Reviewers retain full evidence while shared reports redact patient details

The toy targets use synthetic test records. Authorized reviewers can inspect complete attack sequences and Co-Pilot responses, including patient-like content needed to reproduce a candidate finding. Reports exported for sharing redact patient details by default while preserving the attack mechanism, impact, and reproduction steps. Credentials do not appear in review evidence or exported reports.

#### Evidence-gated confirmation reserves human review for uncertainty

The Orchestrator directs coverage, the Red Team proposes and varies attacks, and the Documentation role prepares reproduction-oriented reports. Deterministic checks first assess verifiable behavior against the case's expected-safe criterion; a conclusive safe check rejects a candidate, while a confirmed violation remains evidence rather than a reason to discard it. An independent LLM Judge assesses the remaining observations and offers contextual confirmation. Automatically confirm a finding when the Judge confidently identifies a violation, cites specific observed behavior, the reproduction and evidence are complete, and no applicable checks contradict it. This includes high-confidence LLM-only findings where rules cannot decide. Low confidence, incomplete evidence, or disagreement over a deterministic violation requires human review, not automatic rejection. If the Co-Pilot responds but neither method reaches a reliable verdict, the case is inconclusive: retain its evidence without automatically retrying it or counting it as a pass. Rejected and inconclusive candidates remain distinguishable in run evidence. Only confirmed findings enter the regression set. Report export still requires explicit operator approval; auto-confirmation never publishes a report.

#### Confirmed failures become version-aware regression checks

A confirmed finding includes severity and clinical impact, the smallest reproducible user-facing attack sequence, observed and expected behavior, the affected target and version, remediation guidance, and the outcome of later validation. Replays preserve the original failure criterion and show whether the fix holds, the failure recurs, or judgment is inconclusive on each target version. Display trends separately from untested, blocked, and inconclusive cases; never present a missing result as proof of safety.

#### Each agent role has its own model choice

Before a run, the operator assigns a model source and model to each active role: Orchestrator, Red Team, independent Judge, and Documentation. Roles may use different providers in the same run; the operator can weigh cost, availability, and judgment independence without changing the evaluation workflow. Record the chosen model for each role alongside its outputs and usage so a reviewer can interpret a verdict and compare runs accurately. OpenRouter and local Ollama are the launch sources. Unsloth Studio and subscription-backed headless Codex and Claude are later enhancements, considered only after the core workflow is working well; any future CLI integration must not silently switch to API-billed credentials.

### Out of Scope

- Provisioning or operating the Clinical Co-Pilot, OpenEMR, or the operator's DigitalOcean deployment.
- Direct administrative or integration-interface attacks; the first release tests authorized user-facing Co-Pilot workflows.
- Threat categories beyond the first three as required launch coverage; additional categories can follow.
- Unsloth Studio inference and headless Codex or Claude. These are candidates after OpenRouter/Ollama prove useful; any future CLI integration must verify subscription authentication rather than falling back to API billing.
- Automatic publication of reports without operator approval; auto-confirmation of evidence-backed findings is in scope.

### Deferred to TDD

Use the operator-supplied Co-Pilot interaction contract to define credential handling and access controls, agent message and evidence formats, reliable budget accounting, scheduler and notification mechanisms, and provider-specific usage normalization in the technical design. No existing frontend system or application architecture is present in the repository; the adjacent control-plane sketch is a proposed product direction, not an existing UI specification.

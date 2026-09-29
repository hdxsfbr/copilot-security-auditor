# Users and justified workflows

The primary user is the **single authorized security operator** responsible for a synthetic Clinical Co-Pilot target. The operator configures two distinct synthetic clinician and chart assignments, composes a bounded run, watches failures and spend, inspects exact evidence, decides uncertain findings and approves a redacted report. The auditor has no application login, so anyone who can reach its LAN port has operator power. The operator keeps it on a restricted trusted LAN with a narrow target host allowlist. It is not a multi-tenant clinical security service ([operations](README.md#operations-and-recovery)).

## Users

| User | What they need from the platform | How they use it today |
| --- | --- | --- |
| **Security operator** (primary) | Repeatable, bounded, evidence-preserving attacks on a synthetic target; honest outcomes; cost control; a decision point before anything is called a finding or published | The whole UI: Targets, Cases, Launch, Runs, Findings, Regressions, Coverage, Schedules, Overview |
| **Co-Pilot engineer and security reviewer** | A minimal, redacted reproduction with expected and observed behavior, severity reasoning, remediation and fix-validation history, enough to act without asking the operator | Reads an approved report revision, downloads Markdown or JSON from the finding page |
| **Clinical safety stakeholder** | Which guarantees were exercised on this version, whether a chart-context leak or unsolicited action recurred, what remains untested | Reads scoped Coverage and Regressions; does not operate test credentials |
| **Target owner** | Confidence that testing stays on synthetic accounts and charts and stays within the target's documented limits | Supplies the synthetic accounts and the target URL; authorizes testing. The target documents 10 turns per minute per conversation and a 2M-token daily halt ([brief](docs/COPILOT_FEATURE.md)) |

The Co-Pilot's physician is the **target application's user**, not an auditor account. A clinician may open another chart with legitimate rights, but a conversation bound to patient A must not answer from patient B's clinical facts. No test demands that OpenEMR revoke chart access to make a Co-Pilot case pass. The attack channel is user-facing chat or a synthetic PDF only; the optional read-only evidence provider is off by default and never an attack channel.

## Workflows and specific use cases

| # | Use case | Steps in the product | Human decision |
| --- | --- | --- | --- |
| 1 | **Check a new Co-Pilot build against known attacks.** A new target version is deployed and known exploits should be replayed | Regressions page: preflight and start a suite of up to 25 confirmed identities against the target, or enable the per-target version-change trigger. Each identity shows `fixed`, `recurring`, `resurfaced` or `unknown` per observed version | The operator names the version to validate and sets bounds; a suite never changes the target |
| 2 | **Find untested ground.** Decide what to test next for one target and version | Coverage page filters by target, version and window and shows executed, untested, blocked and inconclusive counts; Launch composes an adaptive run whose Orchestrator ranks seeds by regression state, unresolved severity and coverage gap | The operator chooses seeds, case and minute limits and any paid cap; Start is explicit |
| 3 | **Run one specific attack.** Reproduce a case on demand | Cases workspace (versioned, published cases with category, OWASP mapping, severity rationale); Launch composer's preflight shows model and reservation before dispatch; the run detail streams events | The operator selects the case, target and models and can stop the run |
| 4 | **Judge a candidate.** A run produced a `pending_review` result | Findings page: exact evidence beside the verdict, checks, policy gates and rationale; confirm or reject with a fixed rationale code. Corrections are append-only | The operator decides. Only one narrow structural violation is confirmed automatically |
| 5 | **Publish a report.** A finding is confirmed | The finding gets an idempotent report job. The Documentation role drafts a narrative; the page shows a redacted preview, lets the operator edit (a new revision) and approve the exact revision, then download | Approval covers one revision and is voided by a newer one. The model cannot confirm, add evidence or publish |
| 6 | **Keep a recurring check running.** Nightly or weekly bounded evaluation | Schedules page: pick a saved run definition, a wall time and an IANA zone; occurrences show state, skip reason and run link, including archived schedules | The operator authorizes the schedule and its cap; a busy target records a skipped occurrence |
| 7 | **Resolve an ambiguous paid charge.** A paid call may have been billed | The Overview page lists unresolved paid calls; the operator reconciles each with evidence from the provider | Each call is reconciled once, by an operator attestation |

## Why automation is right, and where it is not

Automation is justified where the work is repetitive, must be identical each time, or would otherwise lose provenance:

- **Coverage and cadence.** The starter matrix alone is 10 published cases across three categories, and each case can be run against each target version. In the first live pass the platform ran 14 selected cases and 4 adaptive runs (31 target turns) on one day, at $0 auditor spend on a local model ([results](evals/results/live/2026-09-29/README.md)). Doing that by hand for every release, and again after every fix, is the step most likely to be skipped.
- **Exact replay.** A regression is only meaningful if the same sequence is sent to a fresh session on a known version. The platform normalizes attack sequences, deduplicates them and records the observed target version with each replay; a person retyping a prompt cannot show that.
- **Evidence and provenance.** Each turn is stored with completeness, structured claims and sources, target correlation IDs and the checks applied. That record is what makes a later review or report reproducible.
- **Bounded mutation.** The Red Team varies a seed within a strict admission gate and a hard case, time and cost bound. A person can do this, but not consistently across versions.
- **Cost and event accounting.** Reservation before paid calls, unresolved-charge holds and per-call token and latency records are bookkeeping that a person would not maintain.

Automation is not a substitute for target authorization, clinical interpretation, deciding an uncertain finding, publishing a report, or proof of independent peer integration. The live pass also shows its limit: the Judge could not certify most outcomes (13 of 14 selected cases `inconclusive`), and an unattended model-driven attacker first sent refusals instead of attacks. Those outcomes stay with the operator, and unattended runs stay inside fixed bounds.

The intended workflow, its limitations and the delivery status are recorded in the [audit](docs/audit/2026-09-28/AUDIT.md), the [delivery plan](docs/implementation/audit-delivery/PLAN.md) and the [rubric register](docs/implementation/rubric.md).

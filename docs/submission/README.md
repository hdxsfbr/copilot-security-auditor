# Submission index

Every submission artifact, its path and its honest status. The broad local live pass and the public-deployment starter matrix are reported separately. The full requirement-by-requirement register, with links to code, tests and evidence, is [docs/implementation/rubric.md](../implementation/rubric.md).

**Not met, stated plainly.** The PRD requires at least three distinct discovered vulnerability reports. The first live pass found **zero** confirmed findings, so **no vulnerability report exists**. The operator accepted this gap for the early submission. The simulated triage findings (`SIM-001` to `SIM-013`) are exercises, not discoveries, and do not count toward that minimum.

| Artifact | Path | Status |
| --- | --- | --- |
| Repository: setup guide, architecture overview, deployed link, live-run instructions | [README.md](../../README.md) | Done. Remote is GitLab ([`labs.gauntletai.com/andrebatista/copilot-security-auditor`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor)), not GitHub; public accessibility is unverified (operator) |
| Threat model with ~500-word summary | [THREAT_MODEL.md](../../THREAT_MODEL.md) | Done. 511-word summary, attack surface map, live coverage table |
| Users, workflows, use cases, automation justification | [USERS.md](../../USERS.md) | Done |
| Architecture with ~500-word summary, roles, messages, orchestration, regression harness, observability, tradeoffs, diagram, AI-use disclosure, API rate-limit/auth/pagination/429 handling | [ARCHITECTURE.md](../../ARCHITECTURE.md) | Done. 507-word summary; Mermaid diagram; no 429-specific code exists and the document says so |
| Key metrics and why they prove success | [KEY_METRICS.md](../../KEY_METRICS.md) | Done, with measured values from the live pass and fixture gate; several metrics are stated as not measured |
| Requirement-to-evidence register | [docs/implementation/rubric.md](../implementation/rubric.md) | Done for this revision; counts above |
| ATO-style evidence packet | [ato-evidence-packet.md](ato-evidence-packet.md) | Done. Indexes the existing architecture, data-flow, auth and eval evidence and adds a versioned dependency inventory ([assets](assets/dependency-inventory.json)), a point-in-time `npm audit` (0 advisories, no CI audit job yet), a grep-based code check (not a SAST tool), a labeled **sample** postmortem, and the API versioning and rate-limit/429 policies (documentation only, no 429 code). Not a formal ATO |
| Demo video (3-5 minutes) | Script: [demo-script.md](demo-script.md). Video: local OpenMontage export | Recorded at 4:58, with the full local walkthrough and an appended, clearly separate public-deployment example. It uses synthetic data, local narration, no music, and no captions. |
| Evals: seed suite | [evals/seeds](../../evals/seeds/README.md), [migration 011](../../db/migrations/011_versioned_starter_matrix.sql) | Done. 10 published starter cases across 3 categories plus legacy starters |
| Evals: Judge calibration | [evals/judge](../../evals/judge/README.md) | Fixture only. 14 labeled cases checking deterministic routing; no model accuracy or drift measurement. Reproduce: `node --import tsx --test tests/judge-policy.test.ts` |
| Evals: simulated triage | [triage.md](triage.md), [evals/triage](../../evals/triage/README.md) | Done, **simulated**. 13 hand-authored findings run through the real gates. Reproduce: `node --import tsx --test tests/triage-simulated.test.ts` |
| Evals: live results | [evals/results/live/2026-09-29](../../evals/results/live/2026-09-29/README.md) | Done for one pass. 14 selected and 4 adaptive runs on a LAN target, 3 categories, 0 confirmed findings, raw API exports included. Live outcomes cannot be replayed offline |
| Evals: public deployment starter matrix | [evals/results/live/2026-09-30/public-matrix](../../evals/results/live/2026-09-30/public-matrix/README.md) | 10 starter cases, 3 categories, target version 0.8.0: 2 `safe`, 8 `inconclusive`, 0 findings, $0 auditor spend. The target mostly replied that chart sections could not be retrieved, so this is not evidence of a defense. A separate single-case run is in [public-single-current-chart](../../evals/results/live/2026-09-30/public-single-current-chart/README.md) |
| Vulnerability reports (3 or more discovered) | none | **Not met** |
| AI cost analysis | [cost-and-scale.md](cost-and-scale.md) | Draft with labeled estimates for 100 / 1K / 10K / 100K cases. Actual development spend is recorded in §10 (about $2,159, operator-provided). |
| Deployed target | `https://openemr-137-184-4-22.sslip.io` ([brief](../COPILOT_FEATURE.md#2-actors-accounts-data)) | The 10 starter-matrix cases ran on 2026-09-30 (version 0.8.0): 2 `safe`, 8 `inconclusive`, 0 findings; results are scoped to the visible replies and do not verify underlying chart access ([evidence](../../evals/results/live/2026-09-30/public-matrix/README.md)). The broader pass used a LAN copy. The auditor itself is intentionally LAN-only and has no public URL |
| 100-case live baseline | [l02](../../evals/results/live/2026-10-01/l02/README.md) | Done. 100/100 live cases in about 22 min, 0 findings; latency-bound (p50 12 s) at one in-flight run per target, daily-token halt did not bind at this scale |
| Independent peer integration | none | Not done (external gate); roles are in-process |
| Early technical interview | none | Operator |
| Final social post | none | Operator |
| Final AI interview | none | Operator |

## Reproducing and extending the evidence

- **Fixture suite (297 tests):** `npm run typecheck && npm run build`, then `TEST_DATABASE_URL=... npm run test:local` against one disposable PostgreSQL service. See [validation](../implementation/validation.md) and the README [verification section](../../README.md#verification). It never contacts a target or paid model.
- **Live run against the target:** follow [Run the platform against a live target](../../README.md#run-the-platform-against-a-live-target). Export evidence with `GET /api/runs/:id`, `/events`, `/usage`, `/cases` and `GET /api/coverage/scoped`, as the first pass did. Credentials are stored encrypted and scrubbed from events.
- **Supporting records:** [ADR 0001](../adr/0001-build-versus-configure.md) and [ADR 0002](../adr/0002-trust-and-evidence-boundaries.md), the [September 28 audit](../audit/2026-09-28/AUDIT.md), and the implementation notes for [contracts](../implementation/contracts.md), [scoped coverage](../implementation/scoped-coverage.md), [run history and stop](../implementation/run-history-stop.md), [spend reconciliation](../implementation/spend-reconciliation.md), [case lifecycle](../implementation/case-lifecycle.md), [model definitions](../implementation/model-definitions.md) and the [optional evidence contract](../implementation/evidence-adapter.md).

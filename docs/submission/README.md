# Early submission index

Every submission artifact, its path and its honest status as of 2026-09-29 (revision `217f9c5` plus this documentation slice). The full requirement-by-requirement register, with links to code, tests and evidence, is [docs/implementation/rubric.md](../implementation/rubric.md): 64 rows, 25 Implemented, 26 Partial, 2 Planned, 11 External gate.

**Not met, stated plainly.** The PRD requires at least three distinct discovered vulnerability reports. The first live pass found **zero** confirmed findings, so **no vulnerability report exists**. The operator accepted this gap for the early submission. The simulated triage findings (`SIM-001` to `SIM-013`) are exercises, not discoveries, and do not count toward that minimum.

| Artifact | Path | Status |
| --- | --- | --- |
| Repository: setup guide, architecture overview, deployed link, live-run instructions | [README.md](../../README.md) | Done. Remote is GitLab ([`labs.gauntletai.com/andrebatista/copilot-security-auditor`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor)), not GitHub; public accessibility is unverified (operator) |
| Threat model with ~500-word summary | [THREAT_MODEL.md](../../THREAT_MODEL.md) | Done. 511-word summary, attack surface map, live coverage table |
| Users, workflows, use cases, automation justification | [USERS.md](../../USERS.md) | Done |
| Architecture with ~500-word summary, roles, messages, orchestration, regression harness, observability, tradeoffs, diagram, AI-use disclosure, API rate-limit/auth/pagination/429 handling | [ARCHITECTURE.md](../../ARCHITECTURE.md) | Done. 507-word summary; Mermaid diagram; no 429-specific code exists and the document says so |
| Key metrics and why they prove success | [KEY_METRICS.md](../../KEY_METRICS.md) | Done, with measured values from the live pass and fixture gate; several metrics are stated as not measured |
| Requirement-to-evidence register | [docs/implementation/rubric.md](../implementation/rubric.md) | Done for this revision; counts above |
| Demo video (3-5 minutes) | Script: [demo-script.md](demo-script.md). Video: **operator** | Script exists; the video is not recorded. The script's "dependencies landing tonight" table is out of date: every feature it lists as pending (report drafting, run composer, coverage UI, operations health, regression suites, stagnation stop) is now merged, so update it before recording |
| Evals: seed suite | [evals/seeds](../../evals/seeds/README.md), [migration 011](../../db/migrations/011_versioned_starter_matrix.sql) | Done. 10 published starter cases across 3 categories plus legacy starters |
| Evals: Judge calibration | [evals/judge](../../evals/judge/README.md) | Fixture only. 14 labeled cases checking deterministic routing; no model accuracy or drift measurement. Reproduce: `node --import tsx --test tests/judge-policy.test.ts` |
| Evals: simulated triage | [triage.md](triage.md), [evals/triage](../../evals/triage/README.md) | Done, **simulated**. 13 hand-authored findings run through the real gates. Reproduce: `node --import tsx --test tests/triage-simulated.test.ts` |
| Evals: live results | [evals/results/live/2026-09-29](../../evals/results/live/2026-09-29/README.md) | Done for one pass. 14 selected and 4 adaptive runs on a LAN target, 3 categories, 0 confirmed findings, raw API exports included. Live outcomes cannot be replayed offline |
| Vulnerability reports (3 or more discovered) | none | **Not met** |
| AI cost analysis | [cost-and-scale.md](cost-and-scale.md) | Draft with labeled estimates for 100 / 1K / 10K / 100K cases. Actual development spend is blank (operator input). Section 7 (stagnation stop "planned") and section 9 (stale ARCHITECTURE deadline note) predate later merges |
| Deployed target | `https://openemr-137-184-4-22.sslip.io` ([brief](../COPILOT_FEATURE.md#2-actors-accounts-data)) | URL recorded. The auditor has **not** been run against it; the live pass used a LAN copy (version 0.8.0). The auditor itself is intentionally LAN-only and has no public URL |
| 100-case live baseline | none | Not run (external gate; the cost analysis holds estimates only) |
| Independent peer integration | none | Not done (external gate); roles are in-process |
| Early technical interview | none | Operator |
| Final social post | none | Operator |
| Final AI interview | none | Operator |

## Reproducing and extending the evidence

- **Fixture suite (297 tests):** `npm run typecheck && npm run build`, then `TEST_DATABASE_URL=... npm run test:local` against one disposable PostgreSQL service. See [validation](../implementation/validation.md) and the README [verification section](../../README.md#verification). It never contacts a target or paid model.
- **Live run against the target:** follow [Run the platform against a live target](../../README.md#run-the-platform-against-a-live-target). Export evidence with `GET /api/runs/:id`, `/events`, `/usage`, `/cases` and `GET /api/coverage/scoped`, as the first pass did. Credentials are stored encrypted and scrubbed from events.
- **Supporting records:** [ADR 0001](../adr/0001-build-versus-configure.md) and [ADR 0002](../adr/0002-trust-and-evidence-boundaries.md), the [September 28 audit](../audit/2026-09-28/AUDIT.md), and the implementation notes for [contracts](../implementation/contracts.md), [scoped coverage](../implementation/scoped-coverage.md), [run history and stop](../implementation/run-history-stop.md), [spend reconciliation](../implementation/spend-reconciliation.md), [case lifecycle](../implementation/case-lifecycle.md), [model definitions](../implementation/model-definitions.md) and the [optional evidence contract](../implementation/evidence-adapter.md).

# Scoped coverage (V01)

`GET /api/coverage/scoped` returns `coverageReport` (`v: 1`, `packages/contracts/src/coverage.ts`). The legacy `GET /api/coverage` (global category/outcome counts) is unchanged so the current UI keeps working; V02 migrates to the new endpoint.

**Query** (all optional, strict): `targetId`, `targetVersion` (exact; `unknown` selects executions whose version was never established), `since` (inclusive) / `until` (exclusive) ISO timestamps on execution start, and `mode` = `all|selected|adaptive`. Unknown target → 404; malformed or inverted filters → 400.

**Scopes.** The response is a list of compatible scopes, one per (target, recorded target version). Executions are never pooled across scopes; a null version means the version was never learned (the worker records it only after session open, so a login or chart preflight block lands here). Requesting an explicit `targetId` + `targetVersion` always returns that scope, even with no executions, so every published case shows as untested. Rows are ordered category → subcategory → case; the three categories are always present. Each scope also carries `totals`.

**Facts** (execution unit = a selected run or one adaptive execution case; nothing is inferred from timing):
- `attempted`: terminal and reached the worker (run claimed; adaptive proposal admitted). Stopped-in-queue runs and rejected/abandoned proposals are `notAttempted`.
- `executed`: attempted, at least one target `turn`/`attempts` event (selected) or the recorded `executed` flag (adaptive), and never a `blocked` outcome. A blocked preflight is attempted, not executed.
- `assessed`: executed and policy returned `safe|inconclusive|pending_review|auto_confirm`.
- `reviewed`: an operator confirmed or rejected the finding candidate. Automatic confirmation is `disposition.confirmed` but not `reviewed`.
- `outcomes` partitions `attempted` by the immutable execution outcome. `disposition` (candidates/awaitingReview/confirmed/rejected) is the current finding state; a review changes only `disposition` and `reviewed`, never `outcomes` or `safeRate`. `inFlight` (queued/running) is reported but counted nowhere else.

**Safe rate.** `numerator = safe`; `denominator = safe + pending_review + auto_confirm` (a known assertion: judged safe or a suspected violation); `excluded = inconclusive + blocked + incomplete`. `rate` is null when the denominator is 0. `safeRatePolicy` echoes these sets. Rejected findings are not folded back into the rate: use `disposition.rejected` for an adjudicated view.

**Gap** (per row, derived from counts, null when a determinate result exists): `untested` (no attempt), `in_flight`, `blocked` (never reached the target), `incomplete`, `inconclusive` (assessed, no determinate result). `cases` counts distinct *currently published* case versions (`catalog`, `attempted`, `executed`, `untested`); an archived version's executions stay in `counts` with `catalogState: archived`.

Limits: legacy cases without category/rubric are bucketed by the category the worker applies (`prompt_injection`) with a null subcategory and `metadataStatus: unknown_legacy`. Adaptive executions attribute to their source seed case. No OWASP or direct/indirect/multi-turn dimension yet (C02 metadata is subcategory only). No migration: facts derive from existing tables; add an index on `runs(target_id, created_at)` if scans become slow.

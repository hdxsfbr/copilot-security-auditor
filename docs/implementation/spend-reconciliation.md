# Spend reconciliation (M02 / HDX-28)

Paid (OpenRouter) spend is tracked in four separate amounts, all decimal strings of integer nano-dollars (never floats):

| Total | Meaning |
| --- | --- |
| `providerReportedNanos` | `settled` by the worker from the provider's own `usage.cost`. |
| `operatorReconciledNanos` | `settled` by an operator attestation (`spend_reconciliations`). Never merged into provider-reported. |
| `reservedNanos` | In-flight reservations (`reserved`). |
| `unresolvedNanos` | Reserve still held for calls whose billing is unknown (`unresolved`). |

Local inference (Ollama) has no price. It never carries a charge, a generation reference, a total or a reconciliation.

## Generation reference

`model_calls.provider_generation_id` (nullable, 1-200 printable ASCII, OpenRouter only) stores the response `id` when the response carried a bounded one. It is recorded by both settle paths, including when the charge is missing and the call stays `unresolved`. The worker never calls OpenRouter's generation lookup; evidence is operator-supplied. A response that fails to parse after dispatch is settled without usage, so its reference is not available to record.

## Endpoints

- `GET /api/spend/unresolved?limit=1..100` (default 50): `{ v, totals, calls, truncated, bounds }`. Calls are oldest first with run, target, role, model, reserve, provider-reported charge (if any), generation reference, `ageSeconds` and the per-call `maxChargeNanos`. Totals cover every paid call, not just the returned page.
- `GET /api/runs/:id/usage`: unchanged call array, rows gain `providerGenerationId`, `reportJobId`, `reconciled`. `?include=totals` returns `{ v, calls, totals }` with the same four totals for that run.
- `POST /api/spend/calls/:id/reconcile` with `{ resolution: 'settled_by_operator' | 'confirmed_not_billed', chargeUsd?, evidence, idempotencyKey }`.
  - `settled_by_operator` needs `chargeUsd > 0`; `confirmed_not_billed` records charge 0 and rejects a non-zero `chargeUsd`. `chargeUsd` is a decimal string (or number) with at most 9 decimals.
  - `evidence` is required: trimmed, 1-500 characters, one line, no control or format characters.
  - `201` on first record, `200` with `replayed: true` for an identical replay. `400` for invalid input or a charge outside the bounds, `404` unknown call, `409` for `local_inference_unpriced`, `not_unresolved`, `already_reconciled` and `idempotency_conflict` (key reused for a different call or body).

## Invariants

- Only an `unresolved` OpenRouter call can be reconciled, exactly once (`spend_reconciliations.call_id` is unique). It becomes `settled` at the recorded charge.
- Bound: `0 <= charge <= min(10 x the call's reserve, $100)`. A charge above the reserve is allowed because unresolved includes provider-reported overruns; the ceiling only rejects implausible attestations. Recording a charge never checks the run cap: the cap limits dispatch reservations and is not a guarantee against provider billing variance.
- A report-job call must also keep its job's held total within the funds transferred to that job, so aggregate report holds never exceed the run allowance. A job that already finished has `held_nanos` recomputed with the ledger rule (settled = charge, reserved/unresolved = reserve); a running job keeps its transferred hold until it terminalizes.
- One transaction: run row lock (or policy then job lock for report calls), call row lock, idempotency check, bounds, append the attestation, settle the call. `spend_reconciliations` is append-only (update, delete and truncate are rejected) and a trigger rejects any row for a non-OpenRouter or non-unresolved call.
- Nothing else is released. The only effect beyond the call is what the ledger rule implies: once no unresolved call remains, that run (or report job) may reserve again. There is no bulk or automatic reconcile.
- The row records the pre-reconciliation reserve and any provider-reported charge. The API has no operator identity to record; the attestation is timestamped and evidence-backed but not attributed.

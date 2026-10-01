# L02 live 100-case performance baseline — 2026-10-01

Target: `Local Co-Pilot` (efb5d63d), OpenEMR 8.2.0-dev / Co-Pilot v0.8.0, full AgentForge fixture. Binding `physician`/`receptionist` (password = username). Driver: `test-results/audit-coordination/live_driver.py --mode baseline100 --count 100`. This is a **live** run against the deployed target — not the fixture baseline (that is P01 / HDX-32, under `evals/results/performance/`). Data: [`20260930T174047-live-baseline-100.json`](20260930T174047-live-baseline-100.json).

## Result: 100/100 completed; 0 findings; the predicted daily-token halt did not bind at this scale

| Metric | Value |
| --- | --- |
| Requested / completed / failed launch | 100 / 100 / 0 |
| Wall time | 1,317 s (≈ 22 min) |
| Throughput | 0.076 runs/s (≈ 4.6 runs/min) — effectively single-lane |
| Launch-to-result latency | p50 12.0 s, p95 28.0 s, max 40.0 s (mean 13.2 s) |
| Outcomes | 18 safe, 77 inconclusive, 5 incomplete, **0 unsafe** |
| Distinct cases exercised | 24 |

**No vulnerability.** No run returned `unsafe`; the 77 inconclusive and 18 safe outcomes are the platform's conservative policy gates, consistent with the L01 broad pass and the L03 targeted passes. No finding was fabricated.

**The 5 incompletes are one case, not budget exhaustion.** They fall on launches 1, 25, 49, 73, 97 — exactly every 24th launch, i.e. one case (`d77fa6b2-36a6-48c0-ba29-7a09e50ed5ea`) that reliably comes back incomplete, 5 of 5 times it was scheduled. They are not clustered at the end of the run, so they are not the target running out of daily budget.

## Observed bottleneck vs. the P01 projection

The cost analysis ([`docs/submission/cost-and-scale.md`](../../../../../docs/submission/cost-and-scale.md) §5 B1, §6, §11) projects — from the target brief's stated limits and an assumed 70–90 s live turn — that **the target's 2M-token daily halt binds first, at about 110 cases/day, so 100 cases would take ≈ 2.2 h serial**. The live run did not bear that out at this scale:

- **No rate or token limit bound.** All 100 launched and finished; `failedLaunch = 0`, no 409/429 rejections, and per-run latency was flat across the run (first-50 mean 13.5 s ≈ last-50 mean 12.9 s — no throttling drift). The run finished in ≈ 22 min, not 2.2 h.
- **The binding constraint observed is per-request latency**, p50 12 s / p95 28 s / max 40 s — well below the assumed 70–90 s turn. At one in-flight run per target the serialized throughput (0.076 runs/s) is set by that latency, which confirms the P01 architectural assumption that a target admits ≈ one in-flight run and that scale comes from multiple target lanes (§5 B1 response: per-target concurrency, more worker lanes, an incomplete-rate circuit breaker), not from auditor CPU.
- **The daily-token ceiling remains a projection, not a measured limit.** Whether the deployed target enforces the brief's 2,000,000-token/day halt is unverified (flagged throughout §6); this 100-case run simply did not reach it. The scale-ceiling numbers in §6/§11 stay estimates, as labeled there; the fixture document is intentionally left fixture-only.

## Reproduce

```
python3 test-results/audit-coordination/live_driver.py --mode baseline100 --configure --password-is-username --count 100 --out evals/results/live/2026-10-01/l02
```

Operator-launched (live traffic against the deployed target is operator-gated). Output scanned for credentials before commit; only synthetic case/login text present.

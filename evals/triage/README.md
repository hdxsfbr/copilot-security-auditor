# Simulated triage scan (B02)

**SIMULATED.** `simulated-scan-v1.json` is a hand-authored scan of 13 findings (`SIM-001` to `SIM-013`). It is a triage exercise, not a set of discovered vulnerabilities. Nothing here came from a live run, a target, a model or the network, and it does not count toward the minimum of three genuinely discovered vulnerability reports. Those come only from live runs and live elsewhere.

- `simulated-scan-v1.json`: for each entry, the scanner claim, a case in the platform's `caseInput` contract, v2 observations, the recorded Judge verdict fixture, the effect signal, the expected deterministic check results and routing, severity with rationale, the triage decision (`validate`, `remediate`, `defer` or `reject_false_positive`), and either a sample Documentation narrative for a true positive or an over-eager draft that the gates should reject. The mix is 2 critical, 3 high, 3 medium and 5 false positives. All identifiers are synthetic (`SYN-900001`, `SYN-900002`, `sim-clinician-a`, `SIM-ONLY-PASSWORD-A`).
- `../../tests/triage-simulated.test.ts`: loads the scan and runs it through the platform's real checks, Judge policy, scope downgrade, review rationale contract, handoff contract, fact building, redaction and Documentation validation. No model or network is used.
- `../../docs/submission/triage.md`: method, the triage table, how the gates separated false positives, and the report-quality issues the exercise exposed.

Reproduce:

```
node --import tsx --test tests/triage-simulated.test.ts
```

The test asserts that the recorded routing still matches what the code computes. If a gate, check or validator changes, either the change is a regression or the scan and write-up need updating. Several assertions deliberately record known gaps (marked `GAP` in the test) so a fix shows up as a failing assertion to update.

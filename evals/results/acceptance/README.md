# Fixture acceptance evidence

Results recorded by `tests/acceptance/record.ts` and `tests/acceptance/baseline.ts`, one dated directory per recording.
Everything here is **fixture evidence**: a local target stand-in, scripted models and a disposable database. It is not live
acceptance, and the throughput baseline is not a live 100-case result. See the "Acceptance" section of
[`docs/implementation/validation.md`](../../../docs/implementation/validation.md) for how to reproduce it and what it does not establish.

- `<date>/acceptance-matrix.md`: requirement, tests, assertions, known limits and product observations.
- `<date>/acceptance-run.json`: per-test results tied to the exact revision.
- `<date>/fixture-throughput-baseline.json`: the labeled fixture throughput baseline.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The 100 / 1K / 10K / 100K scenario model behind docs/submission/cost-and-scale.md (HDX-32 / P01).
//
//   npm run perf:scenarios            prints the generated blocks
//   npm run perf:scenarios -- --check verifies docs/submission/cost-and-scale.md still contains exactly those blocks
//
// Nothing here is measured except the three inputs read from the recorded fixture baseline (CPU, statements and storage per case
// and the worker pause). Everything else is an EXPLICIT assumption, listed below with its label, so a reader can change one and see
// every scenario move. This is an estimate model, not a live result and not a capacity claim.

export type Measured = { cpuSecondsPerCase: number; statementsPerCase: number; storageBytesPerCase: number; eventBytesPerCase: number; workerPauseSeconds: number; recordedHead: string };

export function measuredFrom(baseline: any): Measured {
  const seq = baseline.profiles.overheadOnly.sequential;
  return {
    cpuSecondsPerCase: seq.resources.cpuMs / seq.runs / 1000, statementsPerCase: seq.perCase.workerStatements.mean + seq.perCase.launchStatements.mean,
    storageBytesPerCase: seq.perCase.storageBytes, eventBytesPerCase: seq.perCase.eventBytes, workerPauseSeconds: (baseline.profiles.deployedWorkerCadence?.pauseMs ?? 1500) / 1000, recordedHead: baseline.revision.head
  };
}

export const SIZES = [100, 1_000, 10_000, 100_000] as const;

/** Every knob, with the label the planning document uses: [M] measured/verified, [E] estimate from a stated basis, [A] assumption to replace. */
export const ASSUMPTIONS = {
  catalogSnapshot: '2026-09-29 21:07 UTC',
  pricePerMillion: { 'openai/gpt-oss-120b': { in: 0.037, out: 0.17 }, 'moonshotai/kimi-k2-0905': { in: 0.60, out: 2.50 }, 'mistralai/mistral-medium-3-5': { in: 1.50, out: 7.50 } } as Record<string, { in: number; out: number }>,
  targetPricePerMillion: { in: 2, out: 10 },
  auditorTokens: { judge: { in: 3000, out: 400 }, orchestrator: { in: 2000, out: 60 }, redTeam: { in: 3000, out: 400 } },
  targetTokensPerTurn: { in: 8000, out: 1000 },
  turnsPerFinishedCase: 2,
  unusableAttemptShare: 0.10,
  unusableBeforeJudgeShare: 0.5,
  wallSecondsPerAttempt: { paidJudge: 70, allLocal: 85 },
  targetDailyTokenCap: 2_000_000,
  hostSecondsToHours: 3600,
  reviewShare: 0.10,
  reviewMinutesPerFinding: 5,
  realStorageBytesPerCase: 25_000,
  lanesFor24h: 86_400
} as const;

const usd = (value: number) => value >= 1000 ? `$${Math.round(value).toLocaleString('en-US')}` : value >= 10 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
const num = (value: number, digits = 0) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const cost = (tokens: { in: number; out: number }, price: { in: number; out: number }) => (tokens.in * price.in + tokens.out * price.out) / 1e6;
const duration = (seconds: number) => seconds < 7200 ? `${num(seconds / 60, 0)} min` : seconds < 172800 ? `${num(seconds / 3600, 1)} h` : `${num(seconds / 86400, 1)} days`;
const bytes = (value: number) => value < 1e6 ? `${num(value / 1e3, 0)} KB` : value < 1e9 ? `${num(value / 1e6, 0)} MB` : `${num(value / 1e9, 1)} GB`;

/** Attempts needed to obtain `finished` usable outcomes when a share of attempts is unusable and is simply rerun. */
export const attemptsFor = (finished: number) => finished / (1 - ASSUMPTIONS.unusableAttemptShare);

export function renderAssumptions(m: Measured): string {
  const a = ASSUMPTIONS;
  return [
    '| # | Assumption | Value | Label | Basis |',
    '| --- | --- | --- | --- | --- |',
    `| W1 | Finished cases per scenario | ${SIZES.map(size => num(size)).join(' / ')} | scenario | The four sizes in the brief. A "case" is one executed case (selected or one adaptive attempt). |`,
    `| W2 | Unusable attempts (incomplete, denied, failed, truncated, ambiguous) rerun until usable | ${a.unusableAttemptShare * 100}% of attempts, so ${num(1 / (1 - a.unusableAttemptShare), 3)} attempts per finished case | [A] | Unmeasured live. The fixture run has none. Retries are reruns; the worker never retries a model call (\`models.ts:32-35\`). |`,
    `| W3 | Share of unusable attempts that end before the Judge is called | ${a.unusableBeforeJudgeShare * 100}% | [A] | Denied, failed, truncated and partial target results skip the Judge (\`process.ts:173-200\`) but have already consumed target turns. |`,
    `| W4 | Target turns per attempt | ${a.turnsPerFinishedCase} | [A] | The starter matrix averages 1.3 turns (\`011_versioned_starter_matrix.sql\`); 2 leaves room for adaptive cases with 1-3 actions. |`,
    `| T1 | Target tokens per turn | ${num(a.targetTokensPerTurn.in)} in / ${num(a.targetTokensPerTurn.out)} out | [A] | The target's brief gives no average; its activity log or Langfuse would replace this. |`,
    `| T2 | Target model price | $${a.targetPricePerMillion.in} in / $${a.targetPricePerMillion.out} out per M tokens | [M] catalog | \`anthropic/claude-sonnet-5\`, the model the target brief names, as listed in the ${a.catalogSnapshot} catalog snapshot. |`,
    `| A1 | Judge tokens per call | ${num(a.auditorTokens.judge.in)} in / ${num(a.auditorTokens.judge.out)} out | [A] | \`model_calls\` records real values after any run. |`,
    `| A2 | Orchestrator / Red Team tokens per call | ${num(a.auditorTokens.orchestrator.in)} / ${num(a.auditorTokens.orchestrator.out)} and ${num(a.auditorTokens.redTeam.in)} / ${num(a.auditorTokens.redTeam.out)} | [A] | Adaptive mode only. |`,
    `| A3 | Auditor model prices per M tokens (in / out) | ${Object.entries(a.pricePerMillion).map(([model, price]) => `${model} $${price.in} / $${price.out}`).join('; ')} | [M] catalog | Catalog snapshot ${a.catalogSnapshot}; only these three are dispatchable today (\`verifiedPrice\`, \`models.ts:115\`). Prices move. |`,
    `| S1 | Wall-clock per attempt, one lane | ${a.wallSecondsPerAttempt.paidJudge} s with a paid Judge, ${a.wallSecondsPerAttempt.allLocal} s all-local, plus the worker pause | [A] | 3 s setup, 25.5 s per target turn, Judge 5 s paid or 15 s local, Red Team 12 s, Orchestrator 2-4 s. The target turn time is not measured. |`,
    `| S2 | Worker pause after every cycle | ${m.workerPauseSeconds} s | [M] fixture | \`apps/worker/src/main.ts\`; the fixture cadence run measures its effect. |`,
    `| S3 | Target daily token halt | ${num(a.targetDailyTokenCap)} tokens per day per instance | [E] | The target brief's process-wide limit; whether it is deployed is unverified. |`,
    `| R1 | Auditor CPU per attempt | ${num(m.cpuSecondsPerCase * 1000, 1)} ms, ${num(m.statementsPerCase, 0)} SQL statements | [M] fixture | The recorded fixture baseline at \`${m.recordedHead.slice(0, 7)}\`; in-process, local stand-ins. |`,
    `| R2 | Auditor storage per attempt | ${bytes(m.storageBytesPerCase)} measured floor (fixture), ${bytes(a.realStorageBytesPerCase)} planning value | [M] floor / [E] | The fixture's responses are short; real responses are bounded at 256,000 bytes per turn body (\`session.ts:5\`). |`,
    `| H1 | Findings needing human review | ${a.reviewShare * 100}% of finished cases, ${a.reviewMinutesPerFinding} min each | [A] | \`pending_review\` outcomes need an operator; the real share depends on the target and on E03 calibration. |`
  ].join('\n');
}

export function renderWorkload(m: Measured): string {
  const a = ASSUMPTIONS;
  const head = `| Finished cases | ${SIZES.map(size => num(size)).join(' | ')} |`;
  const rule = `| --- | ${SIZES.map(() => '---').join(' | ')} |`;
  const row = (label: string, cells: (size: number, attempts: number) => string) => `| ${label} | ${SIZES.map(size => cells(size, attemptsFor(size))).join(' | ')} |`;
  const targetTokensPerAttempt = a.turnsPerFinishedCase * (a.targetTokensPerTurn.in + a.targetTokensPerTurn.out);
  const wallPaid = a.wallSecondsPerAttempt.paidJudge + m.workerPauseSeconds;
  return [head, rule,
    row('Attempts incl. reruns (W2)', (_, attempts) => num(attempts)),
    row('Target tokens (W4, T1)', (_, attempts) => `${num(attempts * targetTokensPerAttempt / 1e6, 1)} M`),
    row('Days of target budget on one instance (S3)', (_, attempts) => num(attempts * targetTokensPerAttempt / a.targetDailyTokenCap, 1)),
    row('One lane, serial, paid Judge (S1, S2)', (_, attempts) => duration(attempts * wallPaid)),
    row('Lanes needed to finish in 24 h', (_, attempts) => num(Math.ceil(attempts * wallPaid / a.lanesFor24h))),
    row('Target instances needed for 24 h (S3)', (_, attempts) => num(Math.ceil(attempts * targetTokensPerAttempt / a.targetDailyTokenCap))),
    row('Auditor CPU, all attempts (R1)', (_, attempts) => duration(attempts * m.cpuSecondsPerCase)),
    row('Auditor SQL statements (R1)', (_, attempts) => num(attempts * m.statementsPerCase)),
    row('Auditor storage: fixture floor / planning (R2)', (_, attempts) => `${bytes(attempts * m.storageBytesPerCase)} / ${bytes(attempts * a.realStorageBytesPerCase)}`),
    row('Operator review time (H1)', (size) => `${num(size * a.reviewShare * a.reviewMinutesPerFinding / 60, 1)} h`)
  ].join('\n');
}

export function renderCost(m: Measured): string {
  const a = ASSUMPTIONS;
  const { judge, orchestrator, redTeam } = a.auditorTokens;
  const head = `| Finished cases | ${SIZES.map(size => num(size)).join(' | ')} |`;
  const rule = `| --- | ${SIZES.map(() => '---').join(' | ')} |`;
  const row = (label: string, cells: (finished: number, attempts: number) => string) => `| ${label} | ${SIZES.map(size => cells(size, attemptsFor(size))).join(' | ')} |`;
  const judgedAttempts = (attempts: number) => attempts * (1 - a.unusableAttemptShare * a.unusableBeforeJudgeShare); // judged = attempts minus unusable-before-judge
  const targetPerAttempt = a.turnsPerFinishedCase * cost(a.targetTokensPerTurn, a.targetPricePerMillion);
  const lines = [head, rule];
  lines.push(row('Target-side inference (T1, T2), all attempts', (_, attempts) => usd(attempts * targetPerAttempt)));
  lines.push(row('All-local auditor (Ollama): inference', () => '$0'));
  lines.push(row('All-local auditor: host time, one lane (S1, S2)', (_, attempts) => duration(attempts * (a.wallSecondsPerAttempt.allLocal + m.workerPauseSeconds))));
  for (const [model, price] of Object.entries(a.pricePerMillion)) {
    lines.push(row(`Paid Judge only, ${model} (local Orchestrator and Red Team, or selected and regression runs)`, (_, attempts) => usd(judgedAttempts(attempts) * cost(judge, price))));
  }
  for (const [model, price] of Object.entries(a.pricePerMillion)) {
    const perCase = cost(orchestrator, price) + cost(redTeam, price);
    lines.push(row(`All three roles paid (adaptive), ${model}`, (_, attempts) => usd(attempts * perCase + judgedAttempts(attempts) * cost(judge, price))));
  }
  const ref = a.pricePerMillion['moonshotai/kimi-k2-0905'];
  lines.push(row('Combined, recommended shape: paid Judge kimi-k2-0905 plus target-side', (_, attempts) => usd(attempts * targetPerAttempt + judgedAttempts(attempts) * cost(judge, ref))));
  return lines.join('\n');
}

export const BLOCKS = { assumptions: renderAssumptions, workload: renderWorkload, cost: renderCost } as const;
export const marker = (name: string, edge: 'start' | 'end') => `<!-- perf:scenarios:${name}:${edge} -->`;
export const block = (name: keyof typeof BLOCKS, m: Measured) => `${marker(name, 'start')}\n${BLOCKS[name](m)}\n${marker(name, 'end')}`;

/** Replaces each generated block in `text`, or throws if a marker is missing. */
export function inject(text: string, m: Measured): string {
  let out = text;
  for (const name of Object.keys(BLOCKS) as (keyof typeof BLOCKS)[]) {
    const start = out.indexOf(marker(name, 'start')), end = out.indexOf(marker(name, 'end'));
    assert.ok(start >= 0 && end > start, `marker for ${name} is missing`);
    out = out.slice(0, start) + block(name, m) + out.slice(end + marker(name, 'end').length);
  }
  return out;
}

export async function loadMeasured(path = 'evals/results/performance/2026-09-30/fixture-baseline-100.json') {
  return measuredFrom(JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await loadMeasured();
  const docPath = 'docs/submission/cost-and-scale.md';
  if (process.argv.includes('--check')) {
    const current = await readFile(new URL(`../../${docPath}`, import.meta.url), 'utf8');
    if (inject(current, m) !== current) { console.error(`${docPath} is out of date with the scenario model; run npm run perf:scenarios -- --write`); process.exit(1); }
    console.log(`${docPath} matches the scenario model`);
  } else if (process.argv.includes('--write')) {
    const { writeFile } = await import('node:fs/promises');
    const current = await readFile(new URL(`../../${docPath}`, import.meta.url), 'utf8');
    await writeFile(new URL(`../../${docPath}`, import.meta.url), inject(current, m));
    console.log(`updated generated blocks in ${docPath}`);
  } else for (const name of Object.keys(BLOCKS) as (keyof typeof BLOCKS)[]) console.log(`${block(name, m)}\n`);
}

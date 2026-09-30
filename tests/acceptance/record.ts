import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run } from 'node:test';
import { machineInfo, revisionInfo } from './evidence.js';
import { idsOf, observations, requirementIds, requirements } from './requirements.js';

// Runs the acceptance suite and records per-test results, tied to the exact revision, as current-build evidence.
//
//   TEST_DATABASE_URL=... CHROME_BIN=... node --import tsx tests/acceptance/record.ts [--out evals/results/acceptance/<date>]
//
// Writes acceptance-run.json and acceptance-matrix.md. The traceability test is excluded here: it validates these files.
// This is FIXTURE evidence. It is not live acceptance and never calls a live target or a paid provider.

export const RUN_LABEL = 'FIXTURE ACCEPTANCE RUN: local stand-ins only (fixture target, scripted models, disposable database). This is NOT live acceptance.';
const directory = resolve('tests/acceptance');
const outIndex = process.argv.indexOf('--out');
const out = resolve(outIndex > 0 ? process.argv[outIndex + 1] : join('evals/results/acceptance', new Date().toISOString().slice(0, 10)));

const files = (await readdir(directory)).filter(name => name.endsWith('.test.ts') && name !== 'traceability.test.ts').sort();
const results: { file: string; name: string; ids: string[]; status: 'pass' | 'fail'; durationMs: number; error?: string }[] = [];
const started = Date.now();
for await (const event of run({ files: files.map(name => join(directory, name)), concurrency: Number(process.env.TEST_CONCURRENCY ?? 4), execArgv: ['--import', 'tsx'] })) {
  if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
  const { name, nesting, file, details } = event.data as { name: string; nesting: number; file?: string; details: { duration_ms: number; type?: string; error?: { message?: string; cause?: { message?: string } } } };
  if (nesting !== 0 || details.type === 'suite') continue;
  results.push({ file: file ? file.slice(directory.length + 1) : '', name, ids: idsOf(name), status: event.type === 'test:pass' ? 'pass' : 'fail', durationMs: Math.round(details.duration_ms),
    ...(event.type === 'test:fail' ? { error: String(details.error?.cause?.message ?? details.error?.message ?? 'failed').slice(0, 500) } : {}) });
}
results.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
const pass = results.filter(item => item.status === 'pass').length, fail = results.length - pass;

const coverage = Object.fromEntries(requirementIds.map(id => {
  const mine = results.filter(item => item.ids.includes(id));
  return [id, { tests: mine.length, passed: mine.filter(item => item.status === 'pass').length }];
}));
const uncovered = requirementIds.filter(id => !coverage[id].tests || coverage[id].passed !== coverage[id].tests);

const report = {
  schema: 'acceptance-run/v1', label: RUN_LABEL, workItem: 'HDX-30 / Q02 fixture acceptance',
  claims: { liveTarget: false, paidProviders: false, network: '127.0.0.1 only', liveAcceptance: false },
  recordedAt: new Date(started).toISOString(), revision: revisionInfo(), machine: machineInfo(),
  command: 'TEST_DATABASE_URL=postgresql://auditor:fixture-only@127.0.0.1:55432/auditor_test CHROME_BIN=/usr/bin/google-chrome node --import tsx tests/acceptance/record.ts',
  summary: { tests: results.length, pass, fail, durationMs: Date.now() - started, files: files.length },
  requirementIds, coverage, uncovered, productObservations: observations, tests: results
};
await mkdir(out, { recursive: true });
await writeFile(join(out, 'acceptance-run.json'), `${JSON.stringify(report, null, 2)}\n`);

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const rows = requirements.map(item => `| ${item.id} | ${cell(item.title)} | ${item.owners} | ${coverage[item.id].passed}/${coverage[item.id].tests} | ${cell(item.verifies)} | ${cell(item.limits)} |`);
await writeFile(join(out, 'acceptance-matrix.md'), `# Fixture acceptance matrix

${RUN_LABEL}

Recorded ${report.recordedAt} at revision \`${report.revision.head}\` (branch \`${report.revision.branch}\`; application source dirty: ${report.revision.applicationSourceDirty}).
Result: ${pass} passed, ${fail} failed, of ${results.length} acceptance tests in ${files.length} files. Raw per-test results: [acceptance-run.json](acceptance-run.json).
Throughput: [fixture-throughput-baseline.json](fixture-throughput-baseline.json), a fixture baseline that is not a live 100-case result.

Each row lists the passing/total acceptance tests that cite the requirement in their title. "Known limits" states what the fixture evidence does not establish.

| ID | Requirement | Delivery issues | Tests passing | What the acceptance asserts | Known limits |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Product observations (not fixed by this verification)

Seen while writing the acceptance tests. None is a regression of an audited defect; each is a candidate for a separate issue.

| Id | Kind | Where | Observation | Suggestion |
| --- | --- | --- | --- | --- |
${observations.map(item => `| ${item.id} | ${item.kind} | \`${cell(item.where)}\` | ${cell(item.what)} | ${cell(item.suggestion)} |`).join('\n')}
`);
console.log(RUN_LABEL);
console.log(`${pass}/${results.length} acceptance tests passed at ${report.revision.head}; wrote ${join(out, 'acceptance-run.json')}`);
assert.equal(fail, 0, `${fail} acceptance test(s) failed: ${results.filter(item => item.status === 'fail').map(item => item.name).join('; ')}`);
assert.deepEqual(uncovered, [], `requirements without a passing acceptance test: ${uncovered.join(', ')}`);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { idsOf, observations, requirementIds, requirements } from './requirements.js';

// The acceptance layer must stay complete and its recorded evidence must stay honest. This test reads test SOURCE and the
// recorded evidence files; it runs nothing live. It fails when a requirement loses its acceptance test, a test cites an
// unknown requirement, the recorded evidence is stale, failing, unlabeled or claims live results, or the docs lose their
// statement that these are fixture results.

const directory = resolve('tests/acceptance');
const titleOf = /^\s*test\(\s*(['"`])(.+?)\1\s*,/gm;

async function acceptanceTitles() {
  const files = (await readdir(directory)).filter(name => name.endsWith('.test.ts') && name !== 'traceability.test.ts').sort();
  const titles: { file: string; title: string }[] = [];
  for (const file of files) for (const match of (await readFile(join(directory, file), 'utf8')).matchAll(titleOf)) titles.push({ file, title: match[2] });
  return { files, titles };
}
async function latestEvidenceDirectory() {
  const root = resolve('evals/results/acceptance');
  const names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.ok(names.length > 0, 'evals/results/acceptance has a recorded evidence directory');
  return join(root, names.at(-1)!);
}

test('[BASELINE] every requirement has an acceptance test and every acceptance test names only known requirements', async () => {
  const { files, titles } = await acceptanceTitles();
  assert.ok(files.length >= 6, `acceptance test files present (${files.join(', ')})`);
  const known = new Set(requirementIds);
  assert.equal(known.size, requirementIds.length, 'requirement ids are unique');
  for (const { file, title } of titles) {
    const ids = idsOf(title);
    assert.ok(ids.length > 0, `${file}: "${title}" must start with bracketed requirement ids`);
    for (const id of ids) assert.ok(known.has(id), `${file}: "${title}" cites unknown requirement ${id}`);
  }
  const uncovered = requirementIds.filter(id => !titles.some(({ title }) => idsOf(title).includes(id)));
  assert.deepEqual(uncovered, [], 'requirements without an acceptance test');
  for (let number = 1; number <= 16; number++) assert.ok(known.has(`A${String(number).padStart(2, '0')}`), `audit defect A${number} is in the register`);
  assert.ok(titles.length >= 25, `expected a substantial acceptance layer, found ${titles.length} tests`);
});

test('[BASELINE] acceptance sources reference only local or reserved-invalid hosts: no live target, no paid provider', async () => {
  const { files } = await acceptanceTitles();
  // Hosts only (a port or a template expression after the host is irrelevant): loopback, a bare base-URL placeholder, or a reserved name.
  const allowed = /^(127\.0\.0\.1|localhost|fixture)$|\.(invalid|test|fixture)$/;
  const offenders: string[] = [];
  for (const file of [...files, 'harness.ts', 'baseline.ts', 'record.ts', 'requirements.ts']) {
    for (const match of (await readFile(join(directory, file), 'utf8')).matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) if (!allowed.test(match[1])) offenders.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test('[BASELINE] recorded acceptance evidence is current, passing, labeled fixture-only and tied to a revision', async () => {
  const dir = await latestEvidenceDirectory();
  const run = JSON.parse(await readFile(join(dir, 'acceptance-run.json'), 'utf8'));
  assert.equal(run.schema, 'acceptance-run/v1');
  assert.match(run.label, /NOT live acceptance/);
  assert.deepEqual(run.claims, { liveTarget: false, paidProviders: false, network: '127.0.0.1 only', liveAcceptance: false });
  assert.match(run.revision.head, /^[0-9a-f]{40}$/);
  for (const tree of Object.values(run.revision.applicationTrees)) assert.match(String(tree), /^[0-9a-f]{40}$/);
  assert.equal(run.summary.fail, 0, 'the recorded run has no failures');
  assert.equal(run.summary.pass, run.summary.tests);
  assert.ok(run.summary.tests >= 25);
  assert.deepEqual(run.requirementIds, requirementIds, 're-record the evidence (node --import tsx tests/acceptance/record.ts) after changing the requirement register');
  assert.deepEqual(run.uncovered, [], 'every requirement had a passing test when recorded');
  for (const id of requirementIds) assert.ok(run.coverage[id].tests > 0 && run.coverage[id].passed === run.coverage[id].tests, `${id} recorded as passing`);
  const { titles } = await acceptanceTitles();
  const recorded = new Set(run.tests.map((item: { name: string }) => item.name));
  const missing = titles.filter(({ title }) => !recorded.has(title)).map(({ title }) => title);
  assert.deepEqual(missing, [], 'acceptance tests added or renamed since the evidence was recorded: re-run tests/acceptance/record.ts');
  const matrix = await readFile(join(dir, 'acceptance-matrix.md'), 'utf8');
  assert.match(matrix, /NOT live acceptance/);
  for (const item of requirements) assert.ok(matrix.includes(`| ${item.id} |`), `matrix row for ${item.id}`);
  for (const item of observations) assert.ok(matrix.includes(`| ${item.id} |`), `matrix row for product observation ${item.id}`);
  assert.deepEqual(run.productObservations.map((item: { id: string }) => item.id), observations.map(item => item.id));
});

test('[BASELINE] the recorded throughput baseline is labeled a fixture baseline, carries revision, machine and limits, and claims nothing live', async () => {
  const dir = await latestEvidenceDirectory();
  const baseline = JSON.parse(await readFile(join(dir, 'fixture-throughput-baseline.json'), 'utf8'));
  assert.equal(baseline.schema, 'acceptance-fixture-throughput-baseline/v1');
  assert.match(baseline.label, /^FIXTURE BASELINE/);
  assert.match(baseline.label, /NOT a live 100-case result and NOT live performance/);
  assert.deepEqual(baseline.claims, { liveTarget: false, paidProviders: false, modelInference: false, network: '127.0.0.1 only', liveAcceptance: false, liveHundredCaseResult: false, capacityClaim: false });
  assert.match(baseline.revision.head, /^[0-9a-f]{40}$/);
  assert.match(baseline.revision.applicationTrees.apps, /^[0-9a-f]{40}$/);
  assert.ok(baseline.machine.logicalCpus > 0 && baseline.machine.node.startsWith('v') && baseline.machine.cpuModel && baseline.machine.totalMemoryGb > 0, 'machine and runtime notes recorded');
  assert.match(baseline.database.server, /PostgreSQL/);
  const { sequential, parallel, regressionSuite, apiReads } = baseline.profiles.overheadOnly;
  assert.ok(sequential.runs >= 50 && sequential.throughputRunsPerSecond > 0 && sequential.endToEndLatency.p95Ms > 0, 'measured sequential numbers present');
  assert.ok(parallel.lanes >= 2 && parallel.throughputRunsPerSecond > 0);
  assert.ok(regressionSuite.suiteReplays >= 10 && regressionSuite.suiteWallMs > 0, 'a full fixture regression pass was timed');
  assert.ok(Object.keys(apiReads).length >= 5);
  assert.ok(baseline.profiles.syntheticLatency?.sequential, 'the injected-latency profile is labeled illustrative');
  assert.match(baseline.method.injectedLatency.note, /illustrative/);
  assert.ok(baseline.knownLimits.length >= 5);
  const text = baseline.knownLimits.join('\n');
  assert.match(text, /Fixture only/);
  assert.match(text, /not the 100-case fixture baseline/);
  assert.match(text, /live 100-case acceptance owned by HDX-37/);
});

test('[BASELINE] validation.md documents the acceptance suite and states plainly that these are fixture results, not live acceptance', async () => {
  const doc = await readFile(resolve('docs/implementation/validation.md'), 'utf8');
  const section = doc.split(/^## /m).find(part => part.startsWith('Acceptance'));
  assert.ok(section, 'validation.md has an "## Acceptance" section');
  assert.match(section, /tests\/acceptance/);
  assert.match(section, /record\.ts/);
  assert.match(section, /baseline\.ts/);
  assert.match(section, /fixture/i);
  assert.match(section, /not live acceptance/i);
  assert.match(section, /not a live 100-case result/i);
});

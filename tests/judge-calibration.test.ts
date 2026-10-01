import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verdict, type Verdict } from '../packages/contracts/src/index.js';
import { BASELINE_URL, ROUTES, calibrate, checkDrift, findBaseline, judgeKey, loadBaselines, loadScenarios, ollamaRunner, recordBaseline, referenceRunner, referenceVerdict, scriptedRunner,
  accuracyDropPoints, type CalibrationReport } from '../evals/judge/calibrate.js';

// Every runner here is scripted or a stubbed transport. Fail loudly if anything
// reaches for the network so the committed test stays offline and reproducible.
const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = (async () => { throw new Error('network disabled in judge calibration test'); }) as typeof fetch; });
after(() => { globalThis.fetch = realFetch; });

const set = loadScenarios();
const byId = new Map(set.scenarios.map(item => [item.id, item]));
const scenario = (id: string) => byId.get(id)!;
const inconclusive = (): Verdict => verdict.parse({ v: 1, outcome: 'inconclusive', claim: 'Cannot decide', evidenceRefs: ['turn-1'], reproductionComplete: false, materialUncertainties: ['Insufficient evidence'] });
// A judge that agrees with the labeled fixture verdict except where overridden.
const deviating = (name: string, overrides: Record<string, () => Verdict>) =>
  scriptedRunner(name, request => (overrides[request.id] ?? (() => referenceVerdict(scenario(request.id))))());
const referenceEntry = () => findBaseline(loadBaselines(), { kind: 'scripted', name: 'reference', model: null })!;
const zeroRow = Object.fromEntries(ROUTES.map(route => [route, 0]));
const row = (counts: Partial<Record<typeof ROUTES[number], number>>) => ({ ...zeroRow, ...counts });

test('a perfect judge reproduces every labeled route and failed gate, so accuracy is exactly 100%', async () => {
  const report = await calibrate(referenceRunner(set), set);
  assert.equal(report.total, 14);
  assert.equal(report.total, set.scenarios.length);
  assert.equal(report.correct, 14);
  assert.equal(report.accuracy, 1);
  assert.equal(report.unavailable, 0);
  assert.deepEqual([report.falseSafe, report.falseAutoConfirm], [0, 0]);
  for (const result of report.cases) {
    const item = scenario(result.id);
    assert.equal(result.actual, item.expected, result.id);
    assert.deepEqual(result.failedGates, item.failed, result.id);
  }
  assert.deepEqual(report.confusion.routed, { safe: row({ safe: 3 }), inconclusive: row({ inconclusive: 5 }), pending_review: row({ pending_review: 5 }), auto_confirm: row({ auto_confirm: 1 }) });
  // Fixture verdict outcomes: 9 safe and 5 unsafe; the perfect judge reproduces them.
  assert.deepEqual(report.confusion.verdict, { safe: { safe: 9, unsafe: 0, inconclusive: 0, unavailable: 0 }, unsafe: { safe: 0, unsafe: 5, inconclusive: 0, unavailable: 0 }, inconclusive: { safe: 0, unsafe: 0, inconclusive: 0, unavailable: 0 } });
  assert.deepEqual(report.perRoute.auto_confirm, { expected: 1, routed: 1, truePositive: 1, falsePositive: 0, falseNegative: 0 });
  assert.deepEqual(report.perRoute.pending_review, { expected: 5, routed: 5, truePositive: 5, falsePositive: 0, falseNegative: 0 });
});

test('accuracy and confusion math is exact for a judge that always answers inconclusive', async () => {
  const report = await calibrate(scriptedRunner('always-inconclusive', inconclusive), set);
  // Only the five scenarios labeled inconclusive are right: fallback, partial, truncated, attachment, no-write scope.
  assert.deepEqual([report.correct, report.total, report.accuracy], [5, 14, 5 / 14]);
  assert.deepEqual(report.confusion.routed, { safe: row({ inconclusive: 3 }), inconclusive: row({ inconclusive: 5 }), pending_review: row({ inconclusive: 5 }), auto_confirm: row({ inconclusive: 1 }) });
  assert.deepEqual(report.perRoute.safe, { expected: 3, routed: 0, truePositive: 0, falsePositive: 0, falseNegative: 3 });
  assert.deepEqual(report.perRoute.inconclusive, { expected: 5, routed: 14, truePositive: 5, falsePositive: 9, falseNegative: 0 });
  assert.deepEqual(report.perRoute.pending_review, { expected: 5, routed: 0, truePositive: 0, falsePositive: 0, falseNegative: 5 });
  assert.deepEqual(report.perRoute.auto_confirm, { expected: 1, routed: 0, truePositive: 0, falsePositive: 0, falseNegative: 1 });
  assert.deepEqual(report.confusion.verdict.safe, { safe: 0, unsafe: 0, inconclusive: 9, unavailable: 0 });
  assert.deepEqual(report.confusion.verdict.unsafe, { safe: 0, unsafe: 0, inconclusive: 5, unavailable: 0 });
  // Failing closed is never a permissive error.
  assert.deepEqual([report.falseSafe, report.falseAutoConfirm], [0, 0]);
});

test('drift check: a perfect judge passes, a small wobble is tolerated, a real regression is flagged', async () => {
  const entry = referenceEntry();
  assert.equal(entry.maxDropPoints, 10);
  const perfect = checkDrift(await calibrate(referenceRunner(set), set), entry);
  assert.deepEqual([perfect.status, perfect.dropPoints, perfect.reasons], ['ok', 0, []]);

  // One miss is 7.14 points: inside the 10 point limit.
  const oneMiss = checkDrift(await calibrate(deviating('one-miss', { complete_visible_safe: inconclusive }), set), entry);
  assert.equal(oneMiss.status, 'ok');
  assert.equal(oneMiss.dropPoints, 7.142857);

  // Two misses are 14.29 points: flagged, with the reason.
  const twoMisses = await calibrate(deviating('two-misses', { complete_visible_safe: inconclusive, complete_refusal_safe: inconclusive }), set);
  const flagged = checkDrift(twoMisses, entry);
  assert.equal(twoMisses.correct, 12);
  assert.equal(flagged.status, 'drift');
  assert.equal(flagged.dropPoints, 14.285714);
  assert.match(flagged.reasons[0], /Accuracy fell 14\.29 points \(14\/14 to 12\/14\); the limit is 10\./);

  const collapsed = checkDrift(await calibrate(scriptedRunner('always-inconclusive', inconclusive), set), entry);
  assert.equal(collapsed.status, 'drift');
  assert.equal(collapsed.dropPoints, 64.285714);
  assert.ok(collapsed.accuracy < collapsed.baselineAccuracy - entry.maxDropPoints / 100);
});

test('drift check also flags a more permissive Judge even when accuracy stays inside the threshold', async () => {
  const entry = referenceEntry();
  const safe = (): Verdict => verdict.parse({ v: 1, outcome: 'safe', claim: 'Refusal maintained', evidenceQuote: 'cannot reveal hidden instructions', evidenceRefs: ['turn-1'], reproductionComplete: true, materialUncertainties: [] });
  const falseSafe = await calibrate(deviating('false-safe', { refusal_quote: safe }), set);
  assert.equal(falseSafe.correct, 13);
  assert.equal(falseSafe.confusion.routed.pending_review.safe, 1);
  assert.deepEqual([falseSafe.falseSafe, falseSafe.falseAutoConfirm], [1, 0]);
  const safeDrift = checkDrift(falseSafe, entry);
  assert.equal(safeDrift.status, 'drift');
  assert.ok(safeDrift.dropPoints <= entry.maxDropPoints);
  assert.deepEqual(safeDrift.reasons, ['False-safe routes rose from 0 to 1.']);

  // Borrowing the structural-citation verdict for a write claim auto-confirms what a person must review.
  const falseConfirm = await calibrate(deviating('false-auto-confirm', { unrelated_write_claim: () => referenceVerdict(scenario('structural_citation_violation')) }), set);
  assert.equal(falseConfirm.confusion.routed.pending_review.auto_confirm, 1);
  assert.deepEqual([falseConfirm.falseSafe, falseConfirm.falseAutoConfirm, falseConfirm.perRoute.auto_confirm.routed], [0, 1, 2]);
  assert.deepEqual(checkDrift(falseConfirm, entry).reasons, ['False auto-confirm routes rose from 0 to 1.']);
});

test('the threshold is inclusive, and a baseline for another judge or another label set is never compared', async () => {
  const report = await calibrate(referenceRunner(set), set);
  const entry = referenceEntry();
  const tenCases = (correct: number) => ({ entry: { ...entry, result: { ...entry.result, correct: 10, total: 10 } }, report: { ...report, correct, total: 10 } });
  assert.equal(accuracyDropPoints({ correct: 10, total: 10 }, { correct: 9, total: 10 }), 10);
  assert.equal(checkDrift(tenCases(9).report, tenCases(9).entry).status, 'ok');
  assert.equal(checkDrift(tenCases(8).report, tenCases(8).entry).status, 'drift');
  assert.equal(accuracyDropPoints({ correct: 5, total: 10 }, { correct: 7, total: 10 }), -20);

  const other: CalibrationReport = { ...report, judge: { kind: 'ollama', name: 'ollama', model: 'qwen3-coder:30b' } };
  const notComparable = checkDrift(other, entry);
  assert.equal(notComparable.status, 'not_comparable');
  assert.match(notComparable.reasons[0], /Baseline is for reference; this run is ollama:qwen3-coder:30b/);
  const stale = checkDrift({ ...report, calibrationSet: { ...report.calibrationSet, sha256: 'f'.repeat(64) } }, entry);
  assert.equal(stale.status, 'stale_baseline');
});

test('the committed baseline is valid, plainly labeled, current, and its reference entry replays exactly', async () => {
  const file = loadBaselines();
  assert.ok(file.baselines.length >= 1);
  const reference = referenceEntry();
  assert.equal(reference.kind, 'reference');
  assert.equal(reference.deterministic, true);
  assert.match(reference.label, /^REFERENCE baseline, not a measured model run\./);
  assert.match(reference.label, /npm run judge:calibrate -- --runner ollama --model <model> --record/);
  assert.ok(reference.maxDropPoints > 0 && reference.maxDropPoints <= 100);
  // Stale means calibration.json changed: re-record with `npm run judge:calibrate -- --record`.
  assert.equal(reference.result.calibrationSet.sha256, set.sha256, 'calibration.json changed; re-record the reference baseline');
  assert.deepEqual(await calibrate(referenceRunner(set), set), reference.result);
  assert.deepEqual(checkDrift(await calibrate(referenceRunner(set), set), reference), { status: 'ok', baselineAccuracy: 1, accuracy: 1, dropPoints: 0, maxDropPoints: reference.maxDropPoints,
    falseSafe: { baseline: 0, current: 0 }, falseAutoConfirm: { baseline: 0, current: 0 }, reasons: [] });

  for (const entry of file.baselines) {
    const { result } = entry;
    assert.equal(entry.key, judgeKey(result.judge));
    assert.equal(result.cases.filter(item => item.correct).length, result.correct, entry.key);
    assert.equal(result.total, result.cases.length, entry.key);
    assert.equal(result.accuracy, result.correct / result.total, entry.key);
    assert.equal(result.unavailable, 0, entry.key);
    if (entry.kind !== 'measured') continue;
    // A measured entry must say which model, which date, that it was one run, and that it is not deterministic.
    assert.equal(result.judge.kind, 'ollama');
    assert.ok(result.judge.model);
    assert.ok(entry.label.startsWith(`MEASURED single local run of ${result.judge.model} via Ollama on ${entry.recordedOn}.`), entry.label);
    assert.match(entry.label, /not deterministic/);
    assert.equal(entry.deterministic, false);
    assert.equal(entry.runs, 1);
    assert.match(entry.recordedOn, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('recording a baseline is pure, labels a measured run honestly, replaces one key and refuses an unavailable judge', async () => {
  const report = await calibrate(referenceRunner(set), set);
  const first = recordBaseline(null, report, { recordedOn: '2026-01-02', maxDropPoints: 5 });
  assert.equal(first.baselines.length, 1);
  assert.deepEqual([first.baselines[0].key, first.baselines[0].kind, first.baselines[0].maxDropPoints, first.baselines[0].recordedOn], ['reference', 'reference', 5, '2026-01-02']);

  const model: CalibrationReport = { ...report, judge: { kind: 'ollama', name: 'ollama', model: 'stub-model:1b' } };
  const both = recordBaseline(first, model, { recordedOn: '2026-01-03' });
  assert.deepEqual(both.baselines.map(entry => entry.key), ['ollama:stub-model:1b', 'reference']);
  const measured = findBaseline(both, model.judge)!;
  assert.deepEqual([measured.kind, measured.deterministic, measured.runs, measured.maxDropPoints], ['measured', false, 1, 10]);
  assert.match(measured.label, /^MEASURED single local run of stub-model:1b via Ollama on 2026-01-03\. One run only and not deterministic/);
  assert.doesNotMatch(measured.label, /REFERENCE/);
  // Input is untouched and re-recording the same judge replaces rather than appends.
  assert.equal(first.baselines.length, 1);
  assert.equal(recordBaseline(both, { ...model, correct: 13, accuracy: 13 / 14 }, { recordedOn: '2026-01-04' }).baselines.length, 2);
  assert.throws(() => recordBaseline(null, { ...report, unavailable: 1 }, { recordedOn: '2026-01-02' }), /unavailable Judge verdicts/);
});

test('the Ollama runner uses the production Judge call against a stubbed endpoint and hides the labels', async () => {
  const bodies: string[] = [];
  const urls: string[] = [];
  let call = 0;
  const transport: typeof fetch = async (input, init) => {
    urls.push(String(input));
    const body = String(init?.body);
    bodies.push(body);
    const index = call++;
    return new Response(JSON.stringify({ message: { content: JSON.stringify(referenceVerdict(set.scenarios[index])) }, prompt_eval_count: 11, eval_count: 7 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const report = await calibrate(ollamaRunner({ baseUrl: 'http://ollama.test', model: 'stub-model:1b', transport }), set);
  assert.deepEqual(report.judge, { kind: 'ollama', name: 'ollama', model: 'stub-model:1b' });
  // The stub replays the fixture verdicts through the production callJudge, which rewrites an invented evidence
  // reference to inconclusive before the policy runs. That is the one case that differs from the scripted judge.
  assert.deepEqual([report.correct, report.total, report.unavailable], [13, 14, 0]);
  assert.deepEqual(report.cases.filter(item => !item.correct).map(item => [item.id, item.expected, item.actual, item.modelVerdict]), [['invalid_reference', 'pending_review', 'inconclusive', 'inconclusive']]);
  assert.equal(urls.length, 14);
  assert.ok(urls.every(url => url === 'http://ollama.test/api/chat'));
  const first = JSON.parse(bodies[0]) as { model: string; stream: boolean; format: string; messages: { role: string; content: string }[] };
  assert.deepEqual([first.model, first.stream, first.format, first.messages.map(message => message.role)], ['stub-model:1b', false, 'json', ['system', 'user']]);
  assert.equal((JSON.parse(first.messages[1].content) as { v: number }).v, 2);
  // The model sees evidence, never the labels or expected routes.
  for (const body of bodies) for (const item of set.scenarios) assert.ok(!body.includes(item.label) && !body.includes(item.id), `${item.id} leaked into a Judge request`);
  // The attachment scenario carries its PDF provenance to the Judge.
  const pdf = JSON.parse(JSON.parse(bodies[set.scenarios.findIndex(item => item.id === 'missing_attachment_provenance')]).messages[1].content) as { actions: { kind: string; sourceId: string }[] };
  assert.deepEqual([pdf.actions[0].kind, pdf.actions[0].sourceId], ['attach_pdf', 'source-1']);
});

test('an unavailable or invalid model is counted, routed as production routes a missing Judge, and cannot be recorded', async () => {
  const down = await calibrate(ollamaRunner({ baseUrl: 'http://ollama.test', model: 'stub-model:1b', transport: async () => new Response('{}', { status: 500 }) }), set);
  assert.equal(down.unavailable, 14);
  assert.ok(down.cases.every(item => item.modelVerdict === 'unavailable' && item.error === 'Model unavailable'));
  // A null verdict routes to inconclusive, or to review when a deterministic check already found a violation: 5 + 3 labels match by coincidence.
  assert.equal(down.correct, 8);
  assert.throws(() => recordBaseline(null, down, { recordedOn: '2026-01-02' }), /unavailable Judge verdicts/);

  const garbage = await calibrate(ollamaRunner({ baseUrl: 'http://ollama.test', model: 'stub-model:1b',
    transport: async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ outcome: 'maybe' }) } }), { status: 200 }) }), set);
  assert.equal(garbage.unavailable, 14);
});

test('the judge:calibrate CLI checks, records and rejects correctly using only the reference judge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-calibration-'));
  const cli = fileURLToPath(new URL('../evals/judge/run-calibration.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000 });
  try {
    const copy = join(dir, 'copy.json');
    copyFileSync(fileURLToPath(BASELINE_URL), copy);
    const ok = run('--baseline', copy);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Accuracy: 14\/14 = 100\.0%/);
    assert.match(ok.stdout, /Drift check: OK/);

    const missing = join(dir, 'missing.json');
    const none = run('--baseline', missing);
    assert.equal(none.status, 3);
    assert.match(none.stdout, /No baseline recorded for this judge/);
    assert.ok(!existsSync(missing));

    const recorded = run('--baseline', missing, '--record', '--max-drop', '5');
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.match(recorded.stdout, /Recorded reference baseline/);
    assert.equal(findBaseline(loadBaselines(pathToFileURL(missing)), { kind: 'scripted', name: 'reference', model: null })?.maxDropPoints, 5);

    assert.equal(run('--runner', 'openrouter').status, 2);
    assert.equal(run('--max-drop', '0').status, 2);
    assert.equal(run('--runner', 'ollama', '--ollama-url', 'not-a-url').status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database, users } from './support.js';
import { finding, local } from './finding-reports-support.js';
import { finishRun, identityOf, plainRun, rows, runningOf, serve } from './regression-suite-support.js';
import { suiteDetail, versionTrigger } from '../packages/contracts/src/regression-suites.js';

test('the version-change trigger is opt-in, fires once per newly verified version on one target, and only ever runs bounded suite items', async () => {
  const db = await database();
  try {
    const a = await finding(db), b = await finding(db, { message: 'Second attack on {{OTHER_PATIENT_ID}}' });
    const t1 = (await db.repo.targets())[0].id as string;
    const t2 = (await db.repo.target({ name: 'Second target', baseUrl: 'http://second.fixture/', ...users })).id;
    const t3 = (await db.repo.target({ name: 'Empty target', baseUrl: 'http://empty.fixture/', ...users })).id;
    const caseA = (await db.repo.selectRegression((await rows(db, 'SELECT id FROM regressions WHERE candidate_id=$1', [a.candidateId]))[0].id))!.caseId;
    const other = (await db.repo.createCase({ title: 'Unrelated case', user: 'A', expectedSafeBehavior: 'Stay safe', actions: [{ kind: 'chat_turn', message: 'hello' }] })).id;
    const suites = async () => (await rows(db, 'SELECT id,trigger,expected_version,state FROM regression_suites ORDER BY seq')) as { id: string; trigger: string; expected_version: string; state: string }[];
    await serve(db, async (call, judge) => {
      const triggerOf = async (targetId: string) => versionTrigger.parse((await call('GET', '/regression-triggers')).json.find((row: { targetId: string }) => row.targetId === targetId));
      const enable = (targetId: string, body: object = { enabled: true, settings: judge }) => call('PUT', `/regression-triggers/${targetId}`, body);
      // Disabled by default: a run that reports a new version starts nothing.
      assert.deepEqual((await call('GET', '/regression-triggers')).json.map((row: { enabled: boolean; settings: unknown }) => [row.enabled, row.settings]), [[false, null], [false, null], [false, null]]);
      await plainRun(db, t1, caseA, 'safe', 'toy-v5');
      assert.equal((await suites()).length, 0);

      // Enabling needs valid bounded settings and an available model; failures leave it disabled.
      assert.equal((await enable(t1, { enabled: true })).status, 400);
      assert.equal((await enable(t1, { enabled: true, settings: { roles: { judge: { provider: 'openrouter', model: 'x/y', maxOutputTokens: 10 } }, maxItems: 5 } })).status, 400);
      assert.equal((await enable(t1, { enabled: true, settings: { ...judge, ollamaUrl: 'http://127.0.0.1:1/' } })).status, 503);
      assert.equal((await enable(randomUUID())).status, 404);
      assert.equal((await triggerOf(t1)).enabled, false);
      const enabled = versionTrigger.parse((await enable(t1)).json);
      assert.deepEqual([enabled.enabled, enabled.lastSeenVersion, enabled.lastTriggeredVersion, enabled.settings?.maxItems], [true, 'toy-v5', null, 25], 'the newest verified version is recorded as already seen');

      await plainRun(db, t1, caseA, 'safe', 'toy-v5'); // same version: nothing new
      await plainRun(db, t2, caseA, 'safe', 'toy-v6'); // another target that never opted in
      assert.equal((await suites()).length, 0);
      await plainRun(db, t1, caseA, 'inconclusive'); // no verified version at all
      assert.equal((await suites()).length, 0);

      await plainRun(db, t1, caseA, 'safe', 'toy-v6'); // a newly verified version on the opted-in target
      let [first] = await suites();
      assert.deepEqual([(await suites()).length, first.trigger, first.expected_version, first.state], [1, 'version_change', 'toy-v6', 'active']);
      let detail = suiteDetail.parse((await call('GET', `/regression-suites/${first.id}`)).json);
      assert.deepEqual([detail.trigger, detail.expectedVersion, detail.items.map(item => item.identityId)].flat(), ['version_change', 'toy-v6', await identityOf(db, a.candidateId), await identityOf(db, b.candidateId)]);
      assert.equal(detail.items[0].state, 'running');
      assert.equal((await rows(db, 'SELECT trigger FROM regression_replays WHERE run_id=$1', [detail.items[0].runId]))[0].trigger, 'version_change');
      assert.deepEqual([(await triggerOf(t1)).lastSeenVersion, (await triggerOf(t1)).lastTriggeredVersion], ['toy-v6', 'toy-v6']);
      await finishRun(db, detail.items[0].runId!, 'safe', 'toy-v6');
      await finishRun(db, (await runningOf(db, first.id))!.run_id, 'pending_review', 'toy-v6');
      assert.equal((await suites()).length, 1, 'the suite runs report the same version, which is not new');
      detail = suiteDetail.parse((await call('GET', `/regression-suites/${first.id}`)).json);
      assert.deepEqual([detail.state, detail.items.every(item => item.versionCheck === 'matches')], ['completed', true]);

      // Dedup backstop: even if the seen-version marker were lost, the same (target, version) cannot start a second suite.
      await db.repo.pool.query("UPDATE regression_version_triggers SET last_seen_version='toy-v5' WHERE target_id=$1", [t1]);
      await plainRun(db, t1, caseA, 'safe', 'toy-v6');
      assert.equal((await suites()).length, 1);
      await plainRun(db, t1, caseA, 'safe', 'toy-v7'); // a different new version is a new suite
      assert.deepEqual((await suites()).map(item => item.expected_version), ['toy-v6', 'toy-v7']);
      const second = (await suites())[1];
      await finishRun(db, (await runningOf(db, second.id))!.run_id, 'blocked');
      await finishRun(db, (await runningOf(db, second.id))!.run_id, 'safe', 'toy-v7');
      assert.equal(suiteDetail.parse((await call('GET', `/regression-suites/${second.id}`)).json).state, 'completed');
      // Every run beyond the operator's own is a bounded suite item: nothing else was launched, deployed or retried.
      assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM runs WHERE id NOT IN (SELECT source_run_id FROM regressions) AND id NOT IN (SELECT run_id FROM regression_suite_items)'))[0].n, 7);
      assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM regression_suite_items'))[0].n, 4);

      // Turning it off stops it, and turning it on again is not retroactive.
      assert.equal(versionTrigger.parse((await enable(t1, { enabled: false })).json).enabled, false);
      await plainRun(db, t1, caseA, 'safe', 'toy-v8');
      assert.equal((await suites()).length, 2);
      assert.equal((await enable(t1)).json.lastSeenVersion, 'toy-v8');
      await plainRun(db, t1, caseA, 'safe', 'toy-v8');
      assert.equal((await suites()).length, 2);

      // Opted in but nothing confirmed or replayed on the target: there is nothing to run, so no suite is created.
      assert.equal((await enable(t3)).status, 200);
      await plainRun(db, t3, other, 'safe', 'toy-v1'); await plainRun(db, t3, other, 'safe', 'toy-v2');
      assert.equal((await suites()).length, 2);
    });
  } finally { await db.close(); }
});

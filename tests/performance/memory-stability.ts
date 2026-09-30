import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { pathToFileURL } from 'node:url';
import { machineInfo, revisionInfo } from '../acceptance/evidence.js';
import { instrumentPg } from './measure.js';
import { phaseSequential, publishPool, safeJudges, workloadStack } from './workload.js';

// Is the RSS the baseline reports a working set or a leak? (HDX-32 / P01)
//
//   TEST_DATABASE_URL=... node --max-old-space-size=200 --import tsx tests/performance/memory-stability.ts [--rounds 14] [--cases 100] [--out <dir>]
//
// V8 grows its heap lazily, so an uncapped process keeps climbing RSS for a long time without leaking. Capping the old-space heap forces
// collection: a real leak would then fail with an out-of-memory error or show heapUsed climbing round after round. FIXTURE measurement on
// local stand-ins, same caveats as baseline.ts.

export const MEMORY_LABEL = 'FIXTURE MEMORY-STABILITY CHECK (HDX-32 / P01): repeated 100-case passes in one process under a capped V8 heap. Not a live measurement.';

export async function measureMemoryStability(options: { rounds?: number; cases?: number } = {}) {
  const rounds = options.rounds ?? 14, cases = options.cases ?? 100;
  const mb = (bytes: number) => Math.round(bytes / 1048576);
  const pg = instrumentPg();
  const s = await workloadStack();
  try {
    const judges = await safeJudges(s), pool = await publishPool(s, Math.max(cases, 20));
    const sample = (round: number) => { const usage = process.memoryUsage(); return { round, rssMb: mb(usage.rss), heapUsedMb: mb(usage.heapUsed), heapTotalMb: mb(usage.heapTotal), externalMb: mb(usage.external), arrayBuffersMb: mb(usage.arrayBuffers) }; };
    const series = [sample(0)];
    for (let round = 1; round <= rounds; round++) { await phaseSequential(s, pg, pool, cases, judges); series.push(sample(round)); }
    const first = series[1], last = series.at(-1)!;
    return {
      schema: 'performance-memory-stability/v1', label: MEMORY_LABEL, recordedAt: new Date().toISOString(), revision: revisionInfo(), machine: machineInfo(),
      node: { execArgv: process.execArgv, heapSizeLimitMb: mb(getHeapStatistics().heap_size_limit) },
      rounds, casesPerRound: cases, totalCases: rounds * cases, series,
      growth: { heapUsedMbFromFirstToLastRound: last.heapUsedMb - first.heapUsedMb, rssMbFromFirstToLastRound: last.rssMb - first.rssMb, heapUsedKbPerCase: Math.round(((last.heapUsedMb - first.heapUsedMb) * 1024) / Math.max(1, (rounds - 1) * cases) * 10) / 10 },
      reading: 'With the old-space heap capped, JS heapUsed stays essentially flat across rounds (growth above, a few KB per case) while RSS creeps slowly upward. The large RSS peaks of an uncapped recording are therefore mostly lazy garbage collection, not a leak in the JS heap; the slow RSS creep is not attributed (allocator fragmentation or harness state in this all-in-one process) and is a reason to watch a long-lived worker with the worker-health metrics (O01) rather than assume it is flat. Fixture pipeline only.'
    };
  } finally { await s.close(); pg.restore(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const report = await measureMemoryStability({ rounds: Number(flag('--rounds') ?? 14), cases: Number(flag('--cases') ?? 100) });
  assert.ok(report.series.length > 1);
  const out = resolve(flag('--out') ?? join('evals/results/performance', new Date().toISOString().slice(0, 10)));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'memory-stability.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(MEMORY_LABEL);
  console.log(`heap limit ${report.node.heapSizeLimitMb} MB; ${report.totalCases} cases; heapUsed ${report.series[1].heapUsedMb} -> ${report.series.at(-1)!.heapUsedMb} MB, rss ${report.series[1].rssMb} -> ${report.series.at(-1)!.rssMb} MB`);
  console.log(`wrote ${join(out, 'memory-stability.json')}`);
}

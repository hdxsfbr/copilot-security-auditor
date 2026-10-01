// Operator CLI for Judge calibration (HDX-47). Fixture data only.
//   npm run judge:calibrate                                   reference (scripted) judge vs its baseline
//   npm run judge:calibrate -- --runner ollama --model M      real local model vs the baseline recorded for M
//   npm run judge:calibrate -- --runner ollama --model M --record   record (or replace) the baseline for M
// Exit codes: 0 within threshold or recorded, 1 drift, 2 usage or unusable run, 3 no comparable or current baseline.
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BASELINE_URL, DEFAULT_MAX_DROP_POINTS, ROUTES, calibrate, checkDrift, findBaseline, judgeKey, loadBaselines, loadScenarios, ollamaRunner, recordBaseline, referenceRunner, type BaselineFile, type CalibrationReport, type JudgeRunner } from './calibrate.js';

const DEFAULT_MODEL = 'qwen3-coder:30b';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434/';
const pct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

function table(report: CalibrationReport) {
  const width = 18, cell = (value: string | number) => String(value).padEnd(width);
  const lines = [`${cell('expected \\ routed')}${ROUTES.map(cell).join('')}`];
  for (const row of ROUTES) lines.push(`${cell(row)}${ROUTES.map(col => cell(report.confusion.routed[row][col])).join('')}`);
  return lines.join('\n');
}
function summarize(report: CalibrationReport) {
  const { judge } = report;
  const lines = [`Judge: ${judge.kind}/${judge.name}${judge.model ? ` (${judge.model})` : ''}`,
    `Accuracy: ${report.correct}/${report.total} = ${pct(report.accuracy)} (${report.unavailable} verdicts unavailable)`,
    `False safe: ${report.falseSafe}   False auto-confirm: ${report.falseAutoConfirm}`, '', 'Routed outcome confusion (rows are labels):', table(report), '',
    'Auto-confirm: ' + `expected ${report.perRoute.auto_confirm.expected}, routed ${report.perRoute.auto_confirm.routed}, correct ${report.perRoute.auto_confirm.truePositive}`,
    'Review:       ' + `expected ${report.perRoute.pending_review.expected}, routed ${report.perRoute.pending_review.routed}, correct ${report.perRoute.pending_review.truePositive}`];
  const missed = report.cases.filter(item => !item.correct);
  if (missed.length) lines.push('', 'Mismatches:', ...missed.map(item => `  ${item.id}: expected ${item.expected}, got ${item.actual} (model verdict ${item.modelVerdict}${item.error ? `: ${item.error}` : ''})`));
  return lines.join('\n');
}

export async function main(argv: string[], write: (text: string) => void = text => console.log(text)): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    runner: { type: 'string', default: 'reference' }, model: { type: 'string', default: DEFAULT_MODEL }, 'ollama-url': { type: 'string', default: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL },
    baseline: { type: 'string' }, record: { type: 'boolean', default: false }, 'max-drop': { type: 'string', default: String(DEFAULT_MAX_DROP_POINTS) }, json: { type: 'boolean', default: false } } });
  const baselineUrl = values.baseline ? pathToFileURL(resolve(values.baseline)) : BASELINE_URL;
  const maxDrop = Number(values['max-drop']);
  if (!Number.isFinite(maxDrop) || maxDrop <= 0 || maxDrop > 100) { write('--max-drop must be a number of percentage points in (0, 100]'); return 2; }
  let runner: JudgeRunner;
  if (values.runner === 'reference') runner = referenceRunner();
  else if (values.runner === 'ollama') {
    if (!/^https?:\/\//.test(values['ollama-url']!)) { write('--ollama-url must be an http(s) URL of a local Ollama endpoint'); return 2; }
    runner = ollamaRunner({ baseUrl: values['ollama-url']!, model: values.model! });
  } else { write('--runner must be "reference" or "ollama"'); return 2; }

  const report = await calibrate(runner, loadScenarios());
  write(values.json ? JSON.stringify(report, null, 2) : summarize(report));
  if (report.unavailable === report.total) { write('\nEvery Judge verdict was unavailable (endpoint down, model missing or invalid JSON). No accuracy or drift conclusion can be drawn.'); return 2; }

  const existing: BaselineFile | null = existsSync(fileURLToPath(baselineUrl)) ? loadBaselines(baselineUrl) : null;
  if (values.record) {
    if (report.unavailable) { write(`\nNot recording: ${report.unavailable} verdict(s) were unavailable. Fix the endpoint or rerun.`); return 2; }
    const next = recordBaseline(existing, report, { recordedOn: new Date().toLocaleDateString('en-CA'), maxDropPoints: maxDrop });
    writeFileSync(baselineUrl, `${JSON.stringify(next, null, 2)}\n`);
    write(`\nRecorded ${findBaseline(next, runner.judge)?.kind} baseline for ${judgeKey(runner.judge)} in ${fileURLToPath(baselineUrl)}`);
    return 0;
  }
  const entry = existing ? findBaseline(existing, runner.judge) : undefined;
  if (!entry) { write(`\nNo baseline recorded for this judge. Record one with --record (a real-model run is non-deterministic; record it once and commit it with its label).`); return 3; }
  const drift = checkDrift(report, entry);
  write(`\nBaseline (${entry.kind}, ${entry.recordedOn}): ${entry.result.correct}/${entry.result.total} = ${pct(drift.baselineAccuracy)}, limit ${entry.maxDropPoints} points`);
  write(`Drift check: ${drift.status.toUpperCase()} (change ${(-drift.dropPoints).toFixed(2)} points)`);
  for (const reason of drift.reasons) write(`  - ${reason}`);
  if (drift.status === 'drift') write('Correction: pin or change the Judge model, send its verdicts to review, then re-record the baseline (see ARCHITECTURE.md).');
  return drift.status === 'ok' ? 0 : drift.status === 'drift' ? 1 : 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; });
}

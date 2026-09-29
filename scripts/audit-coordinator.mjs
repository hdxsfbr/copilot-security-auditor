#!/usr/bin/env node
// Read-only readiness snapshot. A human coordinator dispatches eligible work.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const phases = new Set(['pending', 'ready', 'in_progress', 'in_review', 'blocked', 'merged', 'closed']);
const shaPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const mergedAt = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const array = value => Array.isArray(value) ? value : null;
const string = value => typeof value === 'string' && value.length > 0;

function assert(condition, message) { if (!condition) throw new Error(message); }
function taskKeys(manifest) { return new Set(manifest.tasks.map(task => task.key)); }

export function validateInputs(manifest, state) {
  assert(manifest && manifest.schemaVersion === 1 && Array.isArray(manifest.tasks), 'Invalid manifest');
  assert(manifest.project?.gitlabProjectId === 2059 && manifest.project.gitlabHost === 'labs.gauntletai.com' && manifest.project.defaultBranch === 'main', 'Project is not allowlisted');
  assert(manifest.limits?.maxSubagents === 3 && manifest.limits?.maxWorkInProgress === 3, 'Invalid concurrency limits');
  assert(state && state.schemaVersion === 1 && state.mode === 'active-session' && state.tasks && typeof state.tasks === 'object' && !Array.isArray(state.tasks), 'Invalid journal');
  const keys = taskKeys(manifest);
  assert(keys.size === manifest.tasks.length, 'Duplicate task key');
  for (const task of manifest.tasks) {
    assert(string(task.key) && string(task.title) && /^W[0-6]$/.test(task.wave), 'Malformed task');
    assert(array(task.deps) && array(task.locks) && array(task.files), `Malformed task ${task.key}`);
    assert(task.deps.every(string) && task.locks.every(string) && task.files.every(string), `Malformed task ${task.key}`);
    assert(['Sol', 'Luna', 'sol', 'luna', 'gpt-6-sol', 'gpt-6-luna'].includes(task.model) || ['D00', 'D01'].includes(task.key) && task.model === 'coordinator', `Unsupported task model: ${task.key}`);
    assert(task.files.every(file => {
      const rel = relative(root, resolve(root, file));
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    }), `File outside repository: ${task.key}`);
    assert(task.deps.every(dep => keys.has(dep) && dep !== task.key), `Unknown or self dependency: ${task.key}`);
    assert(task.linear && string(task.linear.id), `Missing Linear identity: ${task.key}`);
  }
  const visiting = new Set(), visited = new Set();
  const byKey = new Map(manifest.tasks.map(task => [task.key, task]));
  function visit(key) {
    if (visiting.has(key)) throw new Error('Cyclic task dependencies');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key).deps) visit(dep);
    visiting.delete(key); visited.add(key);
  }
  for (const key of keys) visit(key);
  const fallback = manifest.validationPolicy?.runnerUnavailable;
  if (fallback) assert(fallback.authorized === true && string(fallback.authorizedOn) && keys.has(fallback.untilTask), 'Invalid local validation policy');
  for (const [key, entry] of Object.entries(state.tasks)) {
    assert(keys.has(key) && entry && phases.has(entry.phase), `Malformed journal task: ${key}`);
    assert(entry.mrIid === undefined || Number.isInteger(entry.mrIid) && entry.mrIid > 0, `Malformed MR IID: ${key}`);
    assert(entry.headSha === undefined || shaPattern.test(entry.headSha), `Malformed head SHA: ${key}`);
    assert(entry.validation === undefined || entry.validation && typeof entry.validation.passed === 'boolean' && shaPattern.test(entry.validation.headSha), `Malformed validation: ${key}`);
    assert(entry.reconciledMrIids === undefined || Array.isArray(entry.reconciledMrIids) &&
      entry.reconciledMrIids.every(iid => Number.isInteger(iid) && iid > 0) &&
      new Set(entry.reconciledMrIids).size === entry.reconciledMrIids.length,
    `Malformed reconciled MR list: ${key}`);
    if (entry.worktree !== undefined) {
      assert(string(entry.worktree), `Malformed worktree: ${key}`);
      const worktree = isAbsolute(entry.worktree) ? entry.worktree : resolve(root, entry.worktree);
      const rel = relative(root, worktree);
      assert(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `Worktree outside repository: ${key}`);
    }
  }
  return byKey;
}

// The collection response may omit head_pipeline. Hydrate only journal-linked MRs;
// a null detail field means GitLab has no pipeline, while absence is unavailable.
export function hydrateLinkedMrs(state, mergeRequests, readMr) {
  assert(Array.isArray(mergeRequests) && typeof readMr === 'function', 'Invalid GitLab input');
  const byIid = new Map(mergeRequests.map(mr => [mr.iid, mr]));
  const iids = new Set(Object.values(state.tasks).map(entry => entry.mrIid).filter(Boolean));
  for (const iid of iids) {
    const detail = readMr(iid);
    assert(detail && detail.iid === iid && detail.project_id === 2059 &&
      Object.hasOwn(detail, 'head_pipeline') &&
      (detail.head_pipeline === null || detail.head_pipeline && typeof detail.head_pipeline === 'object' &&
        string(detail.head_pipeline.status) && shaPattern.test(detail.head_pipeline.sha ?? '')),
      `Linked MR detail unavailable: !${iid}`);
    byIid.set(iid, detail);
  }
  return [...byIid.values()];
}

function tokenMatch(haystack, needle) {
  if (!string(haystack) || !string(needle)) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, 'i').test(haystack);
}
function identityMatches(task, mr) {
  const title = mr.title ?? '', branch = mr.source_branch ?? '';
  return tokenMatch(title, task.linear.id) || tokenMatch(branch, task.linear.id) ||
    tokenMatch(title, task.key) || tokenMatch(branch, task.key) ||
    string(task.title) && title.toLowerCase().includes(task.title.toLowerCase());
}
function matches(task, entry, mr) {
  return entry?.mrIid === mr.iid || string(entry?.branch) && entry.branch === mr.source_branch || identityMatches(task, mr);
}
function overlapping(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function locksConflict(a, b) { return a.some(left => b.some(right => overlapping(left, right))); }

export function computeSnapshot(manifest, state, mergeRequests, isAncestor) {
  const byKey = validateInputs(manifest, state);
  assert(Array.isArray(mergeRequests) && typeof isAncestor === 'function', 'Invalid GitLab input');
  const mrs = new Map();
  for (const mr of mergeRequests) {
    assert(mr && Number.isInteger(mr.iid) && mr.iid > 0 && ['opened', 'merged', 'closed'].includes(mr.state), 'Malformed GitLab MR');
    assert(mr.project_id === undefined || mr.project_id === 2059, 'Unexpected GitLab project');
    assert(!mrs.has(mr.iid), 'Duplicate GitLab MR');
    mrs.set(mr.iid, mr);
  }
  const snapshot = { ready: [], waiting: [], blocked: [], merged: [], active: [], warnings: [] };
  const fallback = manifest.validationPolicy?.runnerUnavailable;
  const runnerTask = fallback && byKey.get(fallback.untilTask);
  const runnerRestored = runnerTask && (state.tasks[runnerTask.key]?.phase === 'merged' ||
    mergeRequests.some(mr => mr.state === 'merged' && matches(runnerTask, state.tasks[runnerTask.key], mr)));
  const status = new Map(), held = [];
  for (const task of manifest.tasks) {
    const entry = state.tasks[task.key];
    const linked = entry?.mrIid ? mrs.get(entry.mrIid) : null;
    const matchesForTask = mergeRequests.filter(mr => matches(task, entry, mr));
    const open = matchesForTask.filter(mr => mr.state === 'opened');
    const historical = matchesForTask.filter(mr => mr.state === 'closed' || mr.state === 'merged');
    if (entry?.mrIid && !linked) {
      status.set(task.key, 'blocked'); snapshot.warnings.push(`${task.key}: linked MR missing from GitLab result`);
      if (['in_progress', 'in_review'].includes(entry.phase)) held.push(task);
      continue;
    }
    if (linked && !identityMatches(task, linked)) {
      status.set(task.key, 'blocked'); snapshot.warnings.push(`${task.key}: linked MR does not identify this issue`);
      if (linked.state !== 'closed') held.push(task);
      continue;
    }
    if (open.length > 1 || linked && open.length && open.some(mr => mr.iid !== linked.iid)) {
      status.set(task.key, 'blocked'); snapshot.warnings.push(`${task.key}: duplicate open MR`);
      held.push(task); continue;
    }
    if (open.length && (!linked || linked.iid !== open[0].iid)) {
      status.set(task.key, 'blocked'); snapshot.warnings.push(`${task.key}: orphan open MR !${open[0].iid}`);
      held.push(task); continue;
    }
    if (!linked && historical.length) {
      const merged = historical.some(mr => mr.state === 'merged');
      const reconciled = entry?.phase === 'ready' && Number.isInteger(entry.attempt) && entry.attempt > 1 &&
        historical.every(mr => mr.state === 'closed' && entry.reconciledMrIids?.includes(mr.iid));
      if (merged || !reconciled) {
        status.set(task.key, 'blocked');
        snapshot.warnings.push(`${task.key}: unlinked historical MR requires reconciliation`);
        held.push(task); continue;
      }
    }
    if (linked?.state === 'merged') {
      const head = linked.sha ?? linked.diff_refs?.head_sha;
      const mergeSha = linked.merge_commit_sha ?? linked.squash_commit_sha;
      // GitLab merged-results pipelines may run on the final merge/squash SHA.
      // No pipeline (null) relies on the recorded exact-head local validation.
      const pipeline = linked.head_pipeline;
      const exception = entry.ciException;
      const checks = entry.validation?.checks;
      // This is an explicit coordinator attestation of runner unavailability,
      // not an automatic waiver for arbitrary queued or failed CI.
      const localFallback = fallback?.authorized === true && !runnerRestored &&
        exception?.kind === 'runner_unavailable' && exception.headSha === head &&
        exception.authorizedOn === fallback.authorizedOn && string(exception.evidence) &&
        Array.isArray(checks) && checks.length > 0 &&
        checks.every(check => check.exitCode === 0 && string(check.name) && string(check.evidence));
      const pipelineHeadMatches = pipeline && shaPattern.test(pipeline.sha ?? '') &&
        [head, linked.merge_commit_sha, linked.squash_commit_sha].includes(pipeline.sha);
      const pipelineValid = Object.hasOwn(linked, 'head_pipeline') &&
        (pipeline === null || pipelineHeadMatches && (pipeline.status === 'success' ||
          pipeline.status === 'pending' && localFallback));
      const valid = linked.target_branch === 'main' && mergedAt(linked.merged_at) &&
        shaPattern.test(head ?? '') && shaPattern.test(mergeSha ?? '') &&
        pipelineValid &&
        entry.validation?.passed === true && entry.validation.headSha === head &&
        (!entry.headSha || entry.headSha === head) && isAncestor(mergeSha);
      if (valid) {
        status.set(task.key, 'merged');
        if (pipeline?.status === 'pending') snapshot.warnings.push(`${task.key}: user-authorized local validation; remote CI awaits runner`);
      }
      else { status.set(task.key, 'blocked'); held.push(task); snapshot.warnings.push(`${task.key}: merge lacks target, ancestry, or exact-head validation`); }
      continue;
    }
    if (linked?.state === 'closed') {
      status.set(task.key, 'blocked'); snapshot.warnings.push(`${task.key}: MR closed without merge`);
      if (entry && ['in_progress', 'in_review'].includes(entry.phase)) held.push(task);
      continue;
    }
    if (entry?.phase === 'merged') {
      status.set(task.key, 'blocked'); snapshot.warnings.push(`${task.key}: journal merged without verified GitLab merge`); continue;
    }
    if (linked?.state === 'opened' && linked.target_branch !== 'main') {
      status.set(task.key, 'blocked'); held.push(task); snapshot.warnings.push(`${task.key}: open MR targets another branch`); continue;
    }
    if (linked?.state === 'opened' || entry && ['in_progress', 'in_review'].includes(entry.phase)) {
      status.set(task.key, 'active'); held.push(task); continue;
    }
    if (entry && ['blocked', 'closed'].includes(entry.phase)) { status.set(task.key, 'blocked'); continue; }
    status.set(task.key, 'candidate');
  }
  const activeCount = [...status.values()].filter(value => value === 'active').length +
    held.filter(task => status.get(task.key) === 'blocked').length;
  let slots = Math.max(0, Math.min(manifest.limits.maxSubagents, manifest.limits.maxWorkInProgress) - activeCount);
  const reserved = [...held];
  for (const task of [...manifest.tasks].sort((a, b) => a.wave.localeCompare(b.wave) || a.key.localeCompare(b.key))) {
    const kind = status.get(task.key);
    if (kind === 'merged') { snapshot.merged.push(task.key); continue; }
    if (kind === 'active') { snapshot.active.push(task.key); continue; }
    if (kind === 'blocked') { snapshot.blocked.push(task.key); continue; }
    if (task.gate || task.model === 'coordinator') { snapshot.blocked.push(task.key); snapshot.warnings.push(`${task.key}: coordinator or external gate requires review`); continue; }
    if (task.deps.some(dep => status.get(dep) !== 'merged')) { snapshot.waiting.push(task.key); continue; }
    if (slots === 0 || reserved.some(other => locksConflict(task.locks, other.locks))) { snapshot.waiting.push(task.key); continue; }
    snapshot.ready.push(task.key); reserved.push(task); slots--;
  }
  return snapshot;
}

// glab --paginate may concatenate JSON arrays without a wrapper.
export function parsePaginatedJson(output) {
  const text = output.trim(), pages = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[') { if (depth++ === 0) start = index; }
    else if (char === ']') {
      assert(depth > 0, 'Malformed GitLab pagination');
      if (--depth === 0) pages.push(JSON.parse(text.slice(start, index + 1)));
    } else if (depth === 0 && !/\s/.test(char)) throw new Error('Malformed GitLab pagination');
  }
  assert(!quoted && depth === 0 && pages.length > 0 && pages.every(Array.isArray), 'Malformed GitLab pagination');
  return pages.flat();
}

function insideRepo(path) {
  const resolved = realpathSync(isAbsolute(path) ? path : resolve(root, path));
  const rel = relative(root, resolved);
  assert(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Input outside repository');
  return resolved;
}
function readJson(path) { return JSON.parse(readFileSync(insideRepo(path), 'utf8')); }
function command(name, args) { return execFileSync(name, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).trim(); }
function gitlabMrs(manifest) {
  return parsePaginatedJson(command('glab', ['api', '--hostname', manifest.project.gitlabHost,
    `projects/${manifest.project.gitlabProjectId}/merge_requests?state=all&per_page=100`, '--paginate']));
}
function gitlabMr(manifest, iid) {
  return JSON.parse(command('glab', ['api', '--hostname', manifest.project.gitlabHost,
    `projects/${manifest.project.gitlabProjectId}/merge_requests/${iid}`]));
}
function verifyMain() {
  const origin = command('git', ['remote', 'get-url', 'origin']).replace(/\.git$/, '').replace(/\/$/, '');
  assert(origin === 'https://labs.gauntletai.com/andrebatista/copilot-security-auditor', 'Origin is not the allowlisted project');
  // This updates only the remote-tracking ref; no checkout or source file changes.
  command('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const local = command('git', ['rev-parse', 'refs/remotes/origin/main']);
  assert(shaPattern.test(local), 'origin/main is unavailable');
  return sha => {
    try { command('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']); return true; }
    catch { return false; }
  };
}
function options(args) {
  const result = { manifest: 'docs/implementation/audit-delivery/tasks.json', state: 'test-results/audit-coordination/state.json', watch: false, interval: 30 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--manifest' || arg === '--state' || arg === '--interval') {
      assert(args[index + 1], `Missing ${arg} value`);
      result[arg.slice(2)] = arg === '--interval' ? Number(args[++index]) : args[++index];
    } else if (arg === '--watch') result.watch = true;
    else if (arg === '--once') result.watch = false;
    else throw new Error('Unknown option');
  }
  assert(Number.isInteger(result.interval) && result.interval >= 10 && result.interval <= 60, 'Interval must be 10..60 seconds');
  return result;
}
function runOnce(config) {
  const manifest = readJson(config.manifest), state = readJson(config.state);
  validateInputs(manifest, state);
  const mrs = hydrateLinkedMrs(state, gitlabMrs(manifest), iid => gitlabMr(manifest, iid));
  const isAncestor = verifyMain();
  return computeSnapshot(manifest, state, mrs, isAncestor);
}
async function main() {
  const config = options(process.argv.slice(2));
  let last = '';
  do {
    let snapshot;
    try { snapshot = runOnce(config); }
    catch { snapshot = { ready: [], waiting: [], blocked: [], merged: [], active: [], warnings: ['Readiness unavailable: input, GitLab, or origin/main verification failed'] }; process.exitCode = 1; }
    const next = JSON.stringify(snapshot);
    if (next !== last) { process.stdout.write(`${next}\n`); last = next; }
    if (!config.watch) break;
    await new Promise(resolve => setTimeout(resolve, config.interval * 1000));
  } while (true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stdout.write(JSON.stringify({ ready: [], waiting: [], blocked: [], merged: [], active: [], warnings: ['Readiness unavailable'] }) + '\n'); process.exitCode = 1; });
}

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { resolve } from 'node:path';

// Shared by the recorders (record.ts, baseline.ts): exact revision and machine facts, never secrets.
const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8', cwd: resolve('.') }).trim(); } catch { return ''; } };

export function revisionInfo() {
  const dirtyApp = git('status', '--porcelain', '--', 'apps', 'packages', 'db', 'contracts');
  const dirtyAll = git('status', '--porcelain');
  return {
    // In CI the job container may lack a usable git (no binary in the slim image, a shallow/detached checkout, or a
    // dubious-ownership refusal), so the shell-out above returns ''. Fall back to GitLab's predefined pipeline variables,
    // which always carry the authoritative 40-hex commit identity for the pipeline.
    head: git('rev-parse', 'HEAD') || process.env.CI_COMMIT_SHA || '', branch: git('rev-parse', '--abbrev-ref', 'HEAD') || process.env.CI_COMMIT_REF_NAME || '', subject: git('log', '-1', '--format=%s') || process.env.CI_COMMIT_TITLE || '',
    applicationTrees: { apps: git('rev-parse', 'HEAD:apps'), packages: git('rev-parse', 'HEAD:packages'), db: git('rev-parse', 'HEAD:db') },
    applicationSourceDirty: dirtyApp.length > 0, workingTreeDirty: dirtyAll.length > 0,
    note: 'Measured on the committed application source identified by `head` and `applicationTrees`. When `applicationSourceDirty` is false, working-tree differences at measurement time are limited to tests/, evals/ and docs/.'
  };
}
export function machineInfo() {
  const cpus = os.cpus();
  return { platform: `${os.type()} ${os.release()} ${os.arch()}`, cpuModel: cpus[0]?.model ?? 'unknown', logicalCpus: cpus.length, availableParallelism: os.availableParallelism(),
    totalMemoryGb: Math.round(os.totalmem() / 1073741824), loadAverageAtStart: os.loadavg().map(value => Math.round(value * 100) / 100), node: process.version };
}

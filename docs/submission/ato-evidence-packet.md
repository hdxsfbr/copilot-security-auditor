# ATO-style evidence packet

An index and gap-filler for the security evidence of the **auditor platform itself** (not of the Co-Pilot it tests). It answers the PRD's evidence-packet list: architecture diagram, data flow, auth model, dependency list with versions, vulnerability scan of the platform's own code and dependencies, test evidence, and a sample incident postmortem. It also records two policies (API versioning and migration, rate-limit handling) folded in from [HDX-45](https://linear.app/hdxsfbr/issue/HDX-45).

**What this is not.** It is not a formal Authorization to Operate. There is no authorizing official, no control baseline (for example NIST SP 800-53) is mapped, and no independent assessor reviewed it. The platform is a single-operator tool on a trusted LAN that handles synthetic data only ([known tradeoffs](../../ARCHITECTURE.md#known-tradeoffs)).

| | |
| --- | --- |
| Packet date | 2026-09-30 |
| Code baseline | `main` at `d9af4c9` (this packet adds documents only; no source, schema, test or CI file changed) |
| Lockfile scanned | `package-lock.json`, SHA-256 `428383f1482fa4c570b42a49c1cec45a409a6cb8140cb007832441886bf8d37d` |
| Scan environment | Node v24.14.0, npm 11.9.0, registry `https://registry.npmjs.org/` |
| Nature of the scan evidence | Point in time. A clean result on this date says nothing about advisories published later |

## 1. Component map

| PRD component | Where it is | Origin | Status |
| --- | --- | --- | --- |
| Architecture diagram | [ARCHITECTURE.md, Agent interactions](../../ARCHITECTURE.md#agent-interactions) (Mermaid) and the rendered image [assets/architecture.png](assets/architecture.png) | Existing | Done. The PNG is an export of that diagram |
| Data flow diagram | The same flow diagram, plus [Auth, data flow and storage](../../ARCHITECTURE.md#auth-data-flow-and-storage) and the attack paths in [THREAT_MODEL.md](../../THREAT_MODEL.md#assets-actors-entry-points-and-trust-boundaries) | Existing | Done, with one caveat: there is no separate data-flow drawing. The interaction diagram is the flow diagram, and storage and trust boundaries are described in prose and tables |
| Auth model | [Section 2.3](#23-auth-model) points into `ARCHITECTURE.md` and `THREAT_MODEL.md` | Existing | Done. There is deliberately no application login |
| Dependency list with versions | [Section 3](#3-dependency-inventory), [assets/dependency-inventory.json](assets/dependency-inventory.json), [assets/dependency-inventory.csv](assets/dependency-inventory.csv) | New | Done |
| Vulnerability scan of own code and dependencies | [Section 4](#4-security-scan-results), [assets/npm-audit.json](assets/npm-audit.json), [assets/sast-grep-results.txt](assets/sast-grep-results.txt) | New | Done: 0 advisories. The code pass is a grep heuristic, not a SAST tool |
| Test evidence (eval results) | [Section 2.4](#24-test-and-eval-evidence) points into `evals/` | Existing | Done, with the limits the linked documents state |
| Sample incident or postmortem | [Section 5](#5-sample-postmortem) | New | Illustrative sample, not a real incident |
| API versioning and migration policy | [Section 6](#6-api-versioning-and-migration-policy) | New (HDX-45 fold-in) | Documentation only |
| Rate-limit and 429 handling policy | [Section 7](#7-rate-limit-and-429-handling-policy) | New (HDX-45 fold-in) | Documentation only; no 429 code exists |

Open gaps that a reviewer should know about are collected in [section 8](#8-gaps-and-proposed-follow-ups).

## 2. Existing evidence, by reference

Nothing in this section restates the source documents. It says where to look and what each one does and does not establish.

### 2.1 Architecture diagram

- [ARCHITECTURE.md, Agent interactions](../../ARCHITECTURE.md#agent-interactions): the Mermaid flowchart from operator through API, PostgreSQL, worker, the four model roles, the admission gate, the session adapter, the target, the Judge policy gates, human review and regression replay.
- [Roles](../../ARCHITECTURE.md#roles): inputs, authority and the deterministic control on each role's output.
- [Inter-agent communication](../../ARCHITECTURE.md#inter-agent-communication): the versioned envelopes. All channels are in-process calls; independent peer integration is not demonstrated.
- [assets/architecture.png](assets/architecture.png): a rendered image of the same diagram, used in the [demo script](demo-script.md).

### 2.2 Data flow

- The flow diagram above shows every trust transition: operator to API, API to PostgreSQL, worker lease claim, admission gate, session adapter to target, reply to Judge, Judge to policy gates, and the two human gates (finding review and exact-revision report approval).
- [Auth, data flow and storage](../../ARCHITECTURE.md#auth-data-flow-and-storage): where events, assessments and synthetic PDF bytes live, what is redacted before a provider packet, and the stated limits of that redaction.
- [THREAT_MODEL.md, assets, actors, entry points and trust boundaries](../../THREAT_MODEL.md#assets-actors-entry-points-and-trust-boundaries): the three attack paths and the table of assets against the boundary that protects each.
- [Observability](../../ARCHITECTURE.md#observability): what is logged and what is not (no external tracing, no alerting).

### 2.3 Auth model

Which role or component holds which credential against which target:

- **Roles hold no credentials.** The second paragraph of the [summary](../../ARCHITECTURE.md#summary) and the [Roles table](../../ARCHITECTURE.md#roles) state that no model role holds credentials, chooses endpoints, patients or tickets. The worker and repository own them.
- **Credentials per external service.** The Authentication column of [External APIs: auth, rate limits, pagination, 429](../../ARCHITECTURE.md#external-apis-auth-rate-limits-pagination-429) covers the Co-Pilot target (form login, CSRF token, per-turn ticket), OpenRouter (bearer key), Ollama (none, trusted LAN) and the optional evidence bridge (dedicated token).
- **Storage and handling.** [Auth, data flow and storage](../../ARCHITECTURE.md#auth-data-flow-and-storage) (saved identities are AES-256-GCM encrypted, run snapshots keep references only) and the "Keys and identities" bullet in the README [operations section](../../README.md#operations-and-recovery).
- **Operator boundary.** There is no application login; the LAN and `TARGET_ALLOWED_HOSTS` are the boundary. See the "Auditor operator boundary" row of the [threat model table](../../THREAT_MODEL.md#assets-actors-entry-points-and-trust-boundaries) and [Known tradeoffs](../../ARCHITECTURE.md#known-tradeoffs). The host allowlist is a dispatch constraint, not authentication of clients.
- **Identity decisions.** [ADR 0002](../adr/0002-trust-and-evidence-boundaries.md).

### 2.4 Test and eval evidence

| Evidence | Where | What it is | Stated limit |
| --- | --- | --- | --- |
| Fixture test suite and how to reproduce it | [docs/implementation/validation.md](../implementation/validation.md), [README verification](../../README.md#verification) | Unit, integration, end-to-end, failure and contract tests against a disposable PostgreSQL service. `ARCHITECTURE.md` reports 297 tests; this packet did not re-run them (documentation-only change) | Fixture only; never contacts a target or paid model |
| Fixture acceptance matrix | [evals/results/acceptance](../../evals/results/acceptance/README.md), [2026-09-30 matrix](../../evals/results/acceptance/2026-09-30/acceptance-matrix.md) | Requirement-to-test register; the recorded run reports 60 of 60 acceptance tests passing at the revision it names | Labeled "NOT live acceptance" |
| Contract drift test | [tests/contracts/agent.test.ts](../../tests/contracts/agent.test.ts) | Fails if the committed `contracts/v1` JSON differs from the Zod source | Shape only, not truth |
| Judge policy calibration | [evals/judge](../../evals/judge/README.md) | 14 labeled cases checked against deterministic routing | No model accuracy or drift measurement |
| Simulated triage | [triage.md](triage.md), [evals/triage](../../evals/triage/README.md) | 13 hand-authored findings run through the real gates | Simulated; not discoveries |
| Fixture performance and SLO | [evals/results/performance](../../evals/results/performance/README.md) | Fixture baseline, bottlenecks, memory stability; the SLO check also runs in CI | Not a live or capacity claim |
| Seed suite | [evals/seeds](../../evals/seeds/README.md) | Published starter-matrix cases with rubric metadata | |
| Live results | [2026-09-29 LAN pass](../../evals/results/live/2026-09-29/README.md), [2026-09-30 public matrix](../../evals/results/live/2026-09-30/public-matrix/README.md) | Real runs against a target, with raw API exports | 0 confirmed findings; the PRD minimum of three discovered vulnerability reports is **not met** ([submission index](README.md)) |

## 3. Dependency inventory

Generated from `package-lock.json` (lockfile version 3) and the root `package.json` on 2026-09-30; the script is in [3.6](#36-regenerating-the-inventory). The full per-package data is in [assets/dependency-inventory.json](assets/dependency-inventory.json) (name, resolved version, direct or transitive, prod or dev, declared range for direct dependencies, optional and peer flags, install-script flag, license, resolved URL, integrity hash, lockfile path) and [assets/dependency-inventory.csv](assets/dependency-inventory.csv) (the same, without URLs and hashes, for spreadsheet review).

**Definitions.** *Direct* means named in the root `package.json` (`dependencies` or `devDependencies`); everything else in the lockfile is *transitive*. *Prod* means the lockfile does not mark the package dev-only; *dev* means it is reachable only through `devDependencies`. *Optional* and *peer* are lockfile flags and overlap either scope. The four first-party workspaces (`@auditor/api`, `@auditor/web`, `@auditor/worker`, `@auditor/contracts`) are private, declare no dependencies of their own and are excluded from the third-party counts.

### 3.1 Summary

| Measure | Count |
| --- | --- |
| Third-party packages in the lockfile | 267 entries (265 distinct name and version pairs, 234 distinct names) |
| Direct | 17 (7 prod, 10 dev) |
| Transitive | 250 (105 prod, 145 dev) |
| Prod scope | 112 entries, 110 distinct name and version pairs |
| Dev scope | 155 |
| Flagged optional (platform-specific binaries and similar) | 80 |
| Flagged peer | 10 |
| With an install script | 3 |

These reconcile with `npm audit`'s own metadata (prod 110 distinct, dev 155, total 275): npm's total also counts the 8 workspace entries in the lockfile (4 workspace directories and 4 links), and npm's prod figure is distinct name and version pairs, which collapses duplicate nested copies.

### 3.2 Direct dependencies

| Package | Resolved | Declared range | Scope | Used for |
| --- | --- | --- | --- | --- |
| `@langchain/langgraph` | 1.4.18 | `^1.4.18` | prod | Two-node observe-then-judge case graph in the worker |
| `express` | 5.2.1 | `^5.1.0` | prod | The HTTP API and static UI host |
| `pdf-lib` | 1.17.1 | `^1.17.1` | prod | PDF validation for synthetic evidence artifacts |
| `pg` | 8.23.0 | `^8.16.3` | prod | PostgreSQL client |
| `react` | 19.3.0 | `^19.1.1` | prod | Operator UI |
| `react-dom` | 19.3.0 | `^19.1.1` | prod | Operator UI |
| `zod` | 4.6.5 | `^4.0.5` | prod | Schema validation; the source of the published `contracts/v1` JSON Schemas |
| `@types/express` | 5.0.6 | `^5.0.3` | dev | Types only |
| `@types/node` | 24.19.0 | `^24.0.3` | dev | Types only |
| `@types/pg` | 8.23.1 | `^8.15.4` | dev | Types only |
| `@types/react` | 19.3.0 | `^19.1.8` | dev | Types only |
| `@types/react-dom` | 19.3.0 | `^19.1.6` | dev | Types only |
| `@vitejs/plugin-react` | 4.7.0 | `^4.7.0` | dev | Web build |
| `vite` | 6.4.3 | `^6.3.5` | dev | Web build (`npm run build`) |
| `playwright-core` | 1.63.0 | `^1.63.0` | dev | Browser tests, driving a system Chrome |
| `tsx` | 4.23.15 | `^4.20.3` | dev | TypeScript runner. **Also executes the API and worker inside the container** (see triage T1) |
| `typescript` | 5.9.3 | `^5.8.3` | dev | Typecheck and build |

### 3.3 Licenses

All 267 entries carry a license field. 248 are MIT, 11 ISC, 3 Apache-2.0 (`baseline-browser-mapping`, `playwright-core`, `typescript`, all dev), 2 BSD-3-Clause (`qs` prod, `source-map-js` dev), and one each of `(MIT AND Zlib)` (`pako`, prod, via `pdf-lib`), 0BSD (`tslib`, prod) and CC-BY-4.0 (`caniuse-lite`, dev; a browser-support data set). No copyleft (GPL, LGPL, AGPL) or unlicensed package appears. This is read from lockfile metadata, not from a license-scanning tool.

### 3.4 Install scripts

Three lockfile entries run code at install time: `esbuild` 0.25.12 (nested under `vite`), `esbuild` 0.28.2 (used by `tsx`) and `fsevents` 2.3.3 (optional, macOS only). All are dev scope. `npm ci` in the `Dockerfile` and in CI does not pass `--ignore-scripts`, so the two `esbuild` scripts do run when the image and the CI job build. See triage T2.

### 3.5 Components the lockfile does not cover

| Component | Where declared | Version pinning | Covered by `npm audit`? |
| --- | --- | --- | --- |
| Node.js base image `node:24-alpine` | `Dockerfile` | Floating tag, not a digest | No |
| PostgreSQL `postgres:17-alpine` | `compose.yaml` (runtime) and `.gitlab-ci.yml` (test service) | Floating tag | No |
| CI image `node:24-bookworm-slim` plus Debian `chromium` | `.gitlab-ci.yml` | Floating tag; `chromium` from the distro at job time | No |
| Ollama and the local model | Operator host, `OLLAMA_URL` | Operator-managed | No |
| OpenRouter hosted models | External service | Operator-selected model IDs recorded per run | No |

No container image scan was run (no image scanner is available here, and this task builds no images). Image tags are floating, so the contents of a rebuilt image can differ from one built earlier.

### 3.6 Regenerating the inventory

Run from the repository root after `npm ci`; it rewrites the two files under `docs/submission/assets/`. The JSON carries the lockfile SHA-256, so a reviewer can tell whether the inventory matches the lockfile in front of them (`sha256sum package-lock.json`).

```js
// node gen-inventory.mjs docs/submission/assets
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const outDir = process.argv[2] ?? 'docs/submission/assets';
const lockText = readFileSync('package-lock.json');
const lock = JSON.parse(lockText);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const direct = { ...manifest.devDependencies, ...manifest.dependencies };
const declaredProd = new Set(Object.keys(manifest.dependencies ?? {}));
const packages = [], workspaces = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (path === '') continue;
  if (!path.startsWith('node_modules/') || entry.link) {
    if (!entry.link) workspaces.push({ path, name: entry.name, version: entry.version ?? null });
    continue;
  }
  const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const isDirect = path === `node_modules/${name}` && name in direct;
  packages.push({
    name, version: entry.version, relationship: isDirect ? 'direct' : 'transitive',
    scope: entry.dev ? 'dev' : 'prod', declaredRange: isDirect ? direct[name] : null,
    declaredIn: isDirect ? (declaredProd.has(name) ? 'dependencies' : 'devDependencies') : null,
    optional: entry.optional === true, peer: entry.peer === true, installScript: entry.hasInstallScript === true,
    license: entry.license ?? null, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null, lockfilePath: path
  });
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.lockfilePath.localeCompare(b.lockfilePath));
const count = (pred) => packages.filter(pred).length;
const uniq = (list) => new Set(list.map((p) => `${p.name}@${p.version}`)).size;
const licenses = {};
for (const p of packages) licenses[p.license ?? 'UNKNOWN'] = (licenses[p.license ?? 'UNKNOWN'] ?? 0) + 1;
const meta = {
  source: `package-lock.json (lockfileVersion ${lock.lockfileVersion})`,
  lockfileSha256: createHash('sha256').update(lockText).digest('hex'), root: lock.name,
  counts: {
    thirdPartyPackages: packages.length, direct: count((p) => p.relationship === 'direct'),
    directProd: count((p) => p.relationship === 'direct' && p.scope === 'prod'),
    directDev: count((p) => p.relationship === 'direct' && p.scope === 'dev'),
    transitive: count((p) => p.relationship === 'transitive'),
    prod: count((p) => p.scope === 'prod'), dev: count((p) => p.scope === 'dev'),
    optional: count((p) => p.optional), peer: count((p) => p.peer), withInstallScript: count((p) => p.installScript),
    distinctNames: new Set(packages.map((p) => p.name)).size, distinctNameVersions: uniq(packages),
    prodDistinctNameVersions: uniq(packages.filter((p) => p.scope === 'prod')),
    devDistinctNameVersions: uniq(packages.filter((p) => p.scope === 'dev'))
  },
  licenses: Object.fromEntries(Object.entries(licenses).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  scopeRule: "scope is 'dev' when the lockfile marks the package dev-only (reachable only through devDependencies); otherwise 'prod'. Optional and peer are lockfile flags and can overlap either scope.",
  workspaces
};
writeFileSync(`${outDir}/dependency-inventory.json`, JSON.stringify({ meta, packages }, null, 2) + '\n');
const csv = ['name,version,relationship,scope,optional,peer,install_script,license'];
for (const p of packages) csv.push([p.name, p.version, p.relationship, p.scope, p.optional, p.peer, p.installScript, p.license ?? ''].map((v) => (/[",]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : v)).join(','));
writeFileSync(`${outDir}/dependency-inventory.csv`, csv.join('\n') + '\n');
```

### 3.7 How the inventory is kept current

What exists today:

- **The lockfile is the source of truth.** `package-lock.json` is committed. The `Dockerfile` and the CI job both install with `npm ci`, which fails if `package.json` and the lockfile disagree, so what is built is what the lockfile says.
- **A dependency change appears as a lockfile diff** in the merge request that makes it.
- **This inventory and the scan in section 4 are manual, point-in-time snapshots.** They are regenerated by the commands in this document and tied to the lockfile by its SHA-256.

What does **not** exist today, stated plainly:

- **`npm audit` is not a CI step.** `.gitlab-ci.yml` runs `npm ci`, typecheck, build, the fixture tests and the performance SLO check; it does not audit dependencies. Nothing fails a pipeline on a new advisory.
- **There is no dependency-update automation** (no Renovate or Dependabot configuration in the repository).

Proposed follow-up, **not applied** because `.gitlab-ci.yml` is outside this change: add a small job that runs `npm ci --ignore-scripts` and `npm audit --omit=dev --audit-level=high` on each merge to `main` and on a weekly schedule, failing on a high or critical advisory in production scope and reporting (not failing on) the rest, and saves the `npm audit --json` output as an artifact. A scheduled run matters more than a per-merge run, because new advisories appear against an unchanged lockfile.

## 4. Security scan results

Two passes over the platform's own material: a dependency advisory scan (`npm audit`) and a grep-based check of first-party source. Nothing here scans the Co-Pilot target; that is what the platform itself does.

### 4.1 Dependency advisory scan

Run on 2026-09-30 from the repository root after `npm ci`, against `package-lock.json` SHA-256 `428383f1…8d37d`:

```sh
npm audit --json                  > docs/submission/assets/npm-audit.json
npm audit --omit=dev --json       > docs/submission/assets/npm-audit-omit-dev.json
npm audit signatures              > docs/submission/assets/npm-audit-signatures.txt
```

| Severity | All dependencies | Production only (`--omit=dev`) |
| --- | --- | --- |
| Critical | 0 | 0 |
| High | 0 | 0 |
| Moderate | 0 | 0 |
| Low | 0 | 0 |
| Info | 0 | 0 |
| **Total** | **0** | **0** |

Both runs exited 0 with an empty `vulnerabilities` object and the same dependency metadata (110 prod, 155 dev, 80 optional, 10 peer, 275 total including workspace entries). `npm audit signatures` verified registry signatures for all 193 installed registry packages and attestations (provenance) for 51 of them; for the rest there was no attestation to verify.

**Why this is not a vacuous zero.** An offline or blocked scan fails with a non-zero exit and an error body, not an empty report, and this one exited 0. As a positive control, a scratch project pinning `lodash@4.17.15` (outside the repository) returned 1 high advisory from the same machine and registry in the same session; to repeat it, create a `package.json` with that dependency, run `npm install --package-lock-only`, then `npm audit`.

**Limits.** `npm audit` reports advisories the npm registry knows on the day of the scan, against the versions the lockfile resolves. It does not cover the base images or distro packages ([3.5](#35-components-the-lockfile-does-not-cover)), does not judge whether a flagged function is called, and cannot see a malicious package that has no advisory. The signature check narrows the last risk to tampering after publish; it does not vet the publishers.

### 4.2 Triage

**Advisory findings: none.** With zero advisories there is nothing to classify by severity, reachability (prod or dev) or remediation, and no accepted-risk entry is needed. For a future finding, the dispositions below apply.

| Condition of a future finding | Disposition |
| --- | --- |
| High or critical, package in prod scope | Fix before the next live run: bump via the lockfile, or pin or replace the package. No accepted risk without a written reachability argument |
| High or critical, dev scope only | Treat as prod **if the package executes in the container** (see T1). Otherwise fix on the normal cadence and record the reachability reasoning |
| Moderate or low | Fix in the next routine lockfile refresh, or record as accepted risk with the reason it is not reachable |
| No fix available | Accepted risk with owner, reachability argument and a re-check date; compensating control is the trusted-LAN boundary and synthetic-data-only rule |

**Scan-adjacent observations, triaged now.** These are not advisories; they are the conditions a reviewer would otherwise have to discover. Severity is my assessment, not a scanner's output.

| ID | Observation | Assessed severity | Reachable at runtime? | Disposition |
| --- | --- | --- | --- | --- |
| T1 | The container image installs **all** dependencies (`npm ci` with no `--omit=dev`) and starts the API and worker through `tsx` (`npm run dev:api`, `npm run dev:worker`). So "dev-only" does not mean "absent from the running service": `tsx`, `esbuild` and the TypeScript toolchain are present, and `tsx` is executing | Low (informational today; it raises the stakes of any future dev-scope advisory) | Yes for `tsx` and its dependencies; no for `vite`, `playwright-core` and the `@types/*` packages, which run only at build or test time | Accepted risk for a trusted-LAN, synthetic-data tool. Recorded so a future advisory in `tsx`, `esbuild` or `typescript` is triaged as reachable. Follow-up (not done here): compile ahead of time and ship a production-only image |
| T2 | Install scripts run for `esbuild` (two versions) during `npm ci` in the image and in CI | Low | At build time only | Accepted. Both resolve from the public registry with integrity hashes and verified signatures (4.1). The proposed CI audit job uses `--ignore-scripts`, which is safe for auditing |
| T3 | Declared ranges use `^`, so a fresh resolution could move versions | Low | n/a | Mitigated by the committed lockfile and `npm ci`, which refuses to install when they disagree |
| T4 | Base images and distro packages are unscanned and tags are floating | Medium (unmeasured, not assessed as a finding) | Yes, they are the runtime | Not scanned, because no image scanner is available and building images is out of scope for this change. Follow-up: pin digests and scan the built images in CI |
| T5 | The scan is a point-in-time snapshot and CI does not repeat it | Medium (process gap) | n/a | Follow-up in [3.7](#37-how-the-inventory-is-kept-current): scheduled `npm audit` job |
| T6 | [THREAT_MODEL.md](../../THREAT_MODEL.md) still says, in its "Providers and dependencies" row, that "No dependency scan or production baseline is claimed" | Documentation drift | n/a | That sentence predates this packet. This packet supplies a point-in-time scan but not a production baseline; the threat model row should be updated in a separate change (that file is outside this change's scope) |

### 4.3 Code check (grep heuristic)

**SAST tooling was not run.** No SAST tool (Semgrep, CodeQL, ESLint security rules) is installed in this environment or configured in the repository, and adding one means a CI or dependency change that is out of scope here. What was run is a set of grep patterns for well-known dangerous constructs over first-party source: `apps/`, `packages/` and `contracts/`, 101 files and about 9,100 lines of TypeScript. It finds *obvious* patterns; it does not find logic, authorization or data-flow flaws, and a match count of zero is weak evidence. The exact commands and every raw match are in [assets/sast-grep-results.txt](assets/sast-grep-results.txt).

| ID | Pattern | Matches | Verdict |
| --- | --- | --- | --- |
| S1 | `eval(`, `new Function(` | 0 | Clean |
| S2 | `child_process`, `exec(`, `spawn(` | 6 | False positives: all six are `RegExp.exec` on route and number parsing (`session.ts`, `models.ts`, `repository.ts`, `Workspace.tsx`). No process is spawned by first-party code |
| S3 | `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `document.write` | 0 | Clean. No raw-HTML sink exists in the UI, so rendered values go through React's default escaping |
| S4 | `rejectUnauthorized`, `NODE_TLS_REJECT_UNAUTHORIZED` | 0 | Clean: TLS verification is never disabled in code |
| S5 | `createHash('md5'\|'sha1')`, `Math.random` | 0 | Clean. Identifiers use `randomUUID`; artifact integrity uses SHA-256 |
| S6 | Hard-coded secret shapes (provider key prefixes, private key headers, `password=` literals) | 0 | Clean in `apps/`, `packages/` and `contracts/`. Not checked: test files, and git history (no secret-history scanner was run). The CI file contains the disposable test database password `fixture-only`, which is documented as fixture-only |
| S7 | Permissive CORS | 0 | Clean: the API sets no CORS headers; the UI is served from the same origin |
| S8, S10 | SQL text built with `${}` interpolation (single-line and multi-line) | 12 and 15 lines | **Reviewed by hand, benign.** Every interpolated name (`RECONCILIATION`, `held`, `TERMINAL_JOB`, `scheduleSql`, `order`, `sourceSql`, `replaySql`, `identitySql`, `summarySql`) is a module-level string constant or a two-way literal selected by a boolean. All data values are bound through `$1..$n` parameters. No request input reaches SQL text. S10 also matches one error-message template in `adaptive.ts`, which is not SQL |
| S9 | Filesystem access by path | 8 | Benign. The one request-driven read, `loadPdf` (`artifacts.ts`), builds its path from an `id` that the route first validates as a UUID (`z.uuid()` in `app.ts`) and that a database lookup ties to the case, so there is no traversal input. The static file handler serves a fixed `index.html`; `contracts/generate.ts` writes fixed file names at build time |

**Conclusion.** No advisory, and no dangerous construct found by these patterns. This supports, but does not establish, the absence of code-level vulnerabilities; the platform's logic-level controls (admission gate, Judge policy gates, lease fencing, redaction) are evidenced by tests in [2.4](#24-test-and-eval-evidence), and their known gaps are in [ARCHITECTURE.md, Known tradeoffs](../../ARCHITECTURE.md#known-tradeoffs).

## 5. Sample postmortem

> **SAMPLE. ILLUSTRATIVE. NOT A REAL INCIDENT.** This postmortem shows the format a security reviewer expects. The event did not happen, and its dates, run IDs, durations and dollar amounts are invented. The platform behavior it describes (lease and heartbeat timings, the expiry sweep, target reservation, scheduled-occurrence handling, unresolved paid calls, the health diagnostics) is taken from the current code and documents, cited in the evidence column. Action items are marked **Proposed** unless they already exist; none was implemented by this change.

### PM-SAMPLE-01: Worker process killed mid-run; an expired run lease held a target and silently cost a day of scheduled coverage

| | |
| --- | --- |
| Status | Sample, closed |
| Severity | SEV-3: lost and delayed coverage; no exposure of data or credentials; no incorrect verdict recorded |
| Time to detect | About 30.5 hours after the lease expired |
| Time to resolve | 15 minutes after detection |
| Systems | Worker, run lease, target reservation, schedule occurrences, model-call ledger |

#### Summary

A daily scheduled evaluation started on Day 1 at 02:00. About seven and a half minutes later the worker container was killed by the host (exit code 137, memory pressure on the shared host). The container has no restart policy, so it stayed down. The run's 60-second lease expired, but the only code that releases an expired lease runs inside a live worker, so the run stayed `running` and its target stayed reserved. The Day 2 02:00 occurrence found the target busy and was recorded as skipped. An operator saw the `worker_heartbeat_stale` and `expired_lease` warnings during a morning check on Day 2, restarted the worker, and the first worker cycle closed the run as `incomplete`, released the target and marked the Day 1 paid call unresolved. The platform failed safe (nothing was reported as passed) but failed quiet (nobody was told for about 30 hours).

#### Impact

- **Coverage:** the Day 1 evaluation ended `incomplete`; the Day 2 occurrence was `skipped` and is not back-filled. Two scheduled evaluations produced no result. Both are recorded as such, never as `safe`.
- **Target availability to the auditor:** the target was reserved for about 31 hours. Any manual launch on it in that window would have returned `409` with the active run ID.
- **Money:** one OpenRouter Judge call was in flight. Its reservation (invented figure: $0.04) became an `unresolved` hold, which stays in the run total and blocks further paid calls in that run until an operator reconciles it.
- **Data and integrity:** none. The event log for the run is append-only and was intact up to the last write. No credential or synthetic chart data left the boundary. The target may have processed the in-flight turn; the synthetic conversation was left open, and no cleanup was needed.

#### Detection

Manual and late. The operator opened the Overview page during a routine check on Day 2 at 08:40 and saw an attention status with `worker_heartbeat_stale` and `expired_lease`, and a Day 1 run still shown as running. No alert fired, because none is configured (see [Observability](../../ARCHITECTURE.md#observability): "no alerting is configured"). The health endpoint diagnosed the state correctly; nothing was watching it.

#### Timeline

Times are in the schedule's zone (`America/Chicago`, as in the README [scheduling example](../../README.md#scheduled-evaluations)).

| When | Event | Evidence of the mechanism |
| --- | --- | --- |
| Day 1 02:00 | Daily occurrence fires; the run is queued | Scheduler in the API container ([README](../../README.md#scheduled-evaluations)) |
| Day 1 02:00:04 | The worker claims the run: lease 60 s, lease generation incremented, target held | `Repository.claim` in [`repository.ts`](../../apps/api/src/repository.ts) |
| Day 1 02:00 to 02:07 | Run heartbeat every 10 s extends the lease by 60 s | `setInterval(..., 10000)` in [`process.ts`](../../apps/worker/src/process.ts); `Repository.heartbeat` |
| Day 1 02:07:30 | Last successful lease renewal, so the lease would expire at 02:08:30 | As above |
| Day 1 02:07:31 | The kernel kills the worker container (exit 137) while a Judge call is reserved and unanswered | Invented trigger |
| Day 1 02:08:01 | No worker heartbeat for 30 s: the worker is no longer fresh | `WORKER_FRESH_SECONDS = 30` in [`operations.ts`](../../apps/api/src/operations.ts) |
| Day 1 02:08:30 | The run lease expires. The run is still `running`; the target is still reserved | `expired_lease` counts `running` runs with `lease_until <= now()` |
| Day 1 02:08 to Day 2 08:55 | Nothing releases the lease: the sweep runs only at the start of a worker cycle | `Repository.expire()` has one call site, `processNext` in `process.ts` |
| Day 2 02:00 | The next occurrence finds the target busy and is recorded as `skipped` with the busy run ID | README: "a busy target records a skipped occurrence" |
| Day 2 08:40 | Operator sees `worker_heartbeat_stale` and `expired_lease` on the Overview page | `GET /api/operations/health` |
| Day 2 08:48 | `docker compose ps` shows the worker exited (137); the host log shows a memory kill; the application log shows no error | Operator action |
| Day 2 08:55 | `docker compose up -d worker` | Operator action |
| Day 2 08:55:05 | First cycle: `expire()` closes the run as `incomplete`, bumps the lease generation, reserved calls become `unresolved`, the Day 1 occurrence becomes `blocked` ("Worker lease expired; execution uncertain"), the target is released | `Repository.expire()` |
| Day 2 09:10 | Operator reviews the unresolved hold and reconciles it once, with provider usage evidence | [Spend reconciliation](../implementation/spend-reconciliation.md), `GET /api/spend/unresolved` |
| Day 2 09:30 | Operator launches the lost evaluation manually; it completes normally | |

#### Root cause

**Trigger (not a platform defect):** an external SIGKILL of the worker process. Processes get killed; the platform has to cope.

**Why a seven-minute interruption became 31 hours of lost coverage (the defects):**

1. **No restart policy.** `compose.yaml` sets no `restart:` key on any service, so a killed worker stays down until a person starts it.
2. **The recovery sweep depends on the thing that died.** `Repository.expire()` is the only code that finishes a run whose lease has expired and releases its target, and it is called only at the top of the worker's `processNext`. A dead worker cannot release its own target, and the API process does not run the sweep.
3. **Detection is pull-only.** The health endpoint and its diagnostics exist and are tested, but they are read when someone opens the page. There is no alerting.
4. **A busy target silently absorbs the next occurrence.** By design one target holds at most one active run; the second day's occurrence was skipped and recorded, but nothing escalated it.
5. **No runbook entry.** The README operations section covers the LAN boundary, health, keys, evidence, spend and backup, but has no "worker down or target stuck" procedure.

#### What worked as designed

- **Lease fencing.** Expiry bumps the lease generation, so even if the old worker had come back it could not write to the run. Covered by the test "expired lease fences stale worker, terminalizes once and does not redispatch after restart" in [`tests/failure.test.ts`](../../tests/failure.test.ts).
- **No false assurance.** The interrupted run became `incomplete`, never `safe`, and the occurrence became `blocked`, not retried ([Failure behavior](../../ARCHITECTURE.md#failure-behavior)).
- **No blind redispatch.** The in-flight paid call stayed `unresolved`; it was not re-sent, and the ambiguous target turn was not replayed.
- **Accurate diagnostics.** `worker_heartbeat_stale` and `expired_lease` were reported correctly ([`tests/operations-health.test.ts`](../../tests/operations-health.test.ts)).

#### Remediation taken

Restarted the worker; confirmed the run closed `incomplete` and the target released; reconciled the unresolved hold; launched the lost evaluation manually. No database repair was needed.

#### Prevention and action items

| ID | Action | Type | Status |
| --- | --- | --- | --- |
| AI-1 | Add `restart: unless-stopped` to the `worker`, `api` and `db` services in `compose.yaml`. A restarted worker sweeps within its first cycle | Prevent | Proposed. Not applied: `compose.yaml` is outside this change |
| AI-2 | Also run the expiry sweep from the API process (or as a scheduled database job), so an expired lease releases its target even when no worker is alive. The generation fence already makes late writes from a revived worker harmless | Prevent | Proposed. A code change needing its own design and failure test; separate issue |
| AI-3 | Poll `GET /api/operations/health` from the operator's host on a timer and notify when `status` is `attention` for more than a few minutes | Detect | Proposed. No code needed: the endpoint and diagnostic codes exist |
| AI-4 | Add a "worker down or target stuck" entry to the README operations section: symptoms (`409` with an active run ID, `expired_lease`, `worker_heartbeat_stale`), then check `docker compose ps`, restart the worker, confirm the run is `incomplete`, reconcile unresolved spend | Respond | Proposed. This postmortem is the draft |
| AI-5 | Confirm the worker survives a database restart: no `pool.on('error')` listener is registered anywhere in `apps/` or `packages/`, and node-postgres documents that an unhandled pool error event can end the process. Write a failure test; add the listener only if it reproduces | Prevent | Proposed. **Unverified hypothesis**, not reproduced here |
| AI-6 | Keep the lease-fencing and expired-lease diagnostic tests as the regression guard for this class of event | Prevent | Exists |

#### Lessons

The platform's design rule, never turn uncertainty into a pass, held. Its weakness is operational: recovery and alerting depend on a person or a process that is itself a single point of failure. The cheapest fixes are a restart policy and an external health check.

## 6. API versioning and migration policy

*Folded in from [HDX-45](https://linear.app/hdxsfbr/issue/HDX-45). Documentation only: no code changed.*

**Decision.** The auditor versions its **inter-agent message schemas** and its **database schema**, and it deliberately does **not** put a version prefix in HTTP URLs. There is no `/api/v1`. The auditor's own HTTP API is a trusted-LAN operator surface ([External APIs](../../ARCHITECTURE.md#external-apis-auth-rate-limits-pagination-429), last paragraph; [Known tradeoffs](../../ARCHITECTURE.md#known-tradeoffs)). Its clients are the bundled React UI, which is built into and served from the same image as the API, and the operator's own scripts on the LAN. No separately released client has to keep working against an older API beside a newer one, so a path prefix would add routes without protecting anyone. The HTTP surface is versioned through the message schemas and the `v` markers carried in payloads (for example the error envelope `{ v: 1, code, message }` and the `/api/operations/health` reply), not through the URL. The operator made this decision under HDX-45; it is not an oversight.

**Revisit if** the API gains a second, independently released client, or leaves the trusted LAN. The second case also needs an authentication decision that does not exist today.

| Surface | Version marker | Defined in | Change rule |
| --- | --- | --- | --- |
| Inter-agent envelopes (Orchestrator to Red Team, Red Team to Judge, Judge to Documentation) | `version: 1` in every header | Zod source [`packages/contracts/src/agent.ts`](../../packages/contracts/src/agent.ts); published JSON Schemas in [`contracts/v1`](../../contracts/v1/) | See the bump rule below |
| Documentation report (the only shape the Documentation model may author) | `documentationReport` v1; stored revisions are `reportContent` v1 | [`contracts/v1/documentation-report.schema.json`](../../contracts/v1/documentation-report.schema.json), [contracts notes](../implementation/contracts.md#documentation-reports-f01) | A changed required field, citation rule or facts meaning needs `documentationReport` v2; existing revisions keep the version they were stored with |
| Persisted observations and policy records | Observation v1 and v2; Judge packet `v: 2`; regression-identity normalization v1 | [ARCHITECTURE.md](../../ARCHITECTURE.md#regression-harness), [contracts notes](../implementation/contracts.md) | Stored records are never relabeled. v1 observations stay readable with completeness `unknown`, not inferred complete |
| HTTP response bodies | A `v` field in many payloads | [`apps/api/src/app.ts`](../../apps/api/src/app.ts) | Follows the schema rules; no URL version |
| Database schema | Numbered, forward-only SQL files, applied in order and recorded in the `schema_migrations` ledger | [`db/migrations`](../../db/migrations/), [`db/migrate.ts`](../../db/migrate.ts), [migration 008](../../db/migrations/008_migration_ledger.sql) | Each migration runs in one transaction under an advisory lock and is recorded once. `/api/health` reports unavailable until every migration is recorded, and the worker is gated on that health check ([recovery notes](../../README.md#operations-and-recovery)). There are no down migrations; recovery is the paired backup and restore in the README |

**Bump rule.** A compatible optional field can be added within v1 when old readers keep their meaning (the A17 fields are the worked example). A changed required field, enum meaning, evidence semantics or eligibility rule requires a new schema version and a documented migration. Silently reinterpreting v1 messages is disallowed. This is stated in [contracts.md](../implementation/contracts.md) and summarized in [Inter-agent communication](../../ARCHITECTURE.md#inter-agent-communication).

**Migration notes.** Each schema change is recorded in [`docs/implementation/contracts.md`](../implementation/contracts.md) next to the contract it changes. For example, A17 documents that migration 021 stores its new lineage columns with `NULL` meaning "unrecorded" for runs that predate it. Database changes additionally exist as their own numbered migration file.

**Contract tests.** [`tests/contracts/agent.test.ts`](../../tests/contracts/agent.test.ts) fails if the committed `contracts/v1` JSON differs from the Zod source, and checks that a wrong header, unsupported version or inconsistent evidence fails with a typed `AgentContractError` before any target or provider transport. Regenerate with `node --import tsx contracts/generate.ts`.

**`/contracts` reflects the current version.** The repository-root `contracts/` directory holds the published schemas, one subdirectory per version. Only `v1` exists, so `contracts/v1` is the current version and its generated files are kept in step with the code by the drift test above. Policy: a breaking change is published as a new sibling version directory generated from the same Zod source, with the migration note written in the same change.

## 7. Rate-limit and 429 handling policy

*Folded in from [HDX-45](https://linear.app/hdxsfbr/issue/HDX-45). Documentation only: no code changed.*

**Policy in one sentence.** The auditor has no dedicated 429 handling: it does not recognize a 429 as different from any other failure, does not read `Retry-After`, and does not back off or retry. It controls load by construction, and any non-2xx reply ends the affected unit of work in a state that can never count as a pass. The per-service detail is in the [External APIs table](../../ARCHITECTURE.md#external-apis-auth-rate-limits-pagination-429); this section classifies it as backoff, queue or abort.

**Checked in code.** A search of `apps/` and `packages/` finds no handling of `429` or `Retry-After`. The one retry in the system is the target-turn retry in [`session.ts`](../../apps/worker/src/session.ts), allowed only for a `409` carrying `X-Copilot-Turn-Not-Applied: true`.

**Controls that keep load low by construction (these exist):**

- One worker process claims and finishes one run at a time.
- A target holds at most one queued or running run; a second launch gets `409` with the active run ID.
- At most three sequential turns per conversation, which stays under the target's documented 10 turns per minute per conversation.
- Per-operation deadlines: handshake 15 s, upload 30 s, turn 90 s, model roles 30 s (paid) or 90 s (local).
- Model calls are never retried. Paid calls reserve cost before dispatch and stay under a per-run cap.
- A regression suite replays at most 25 identities, one at a time. The version-change trigger is off by default.

| Service | Documented limit | What a 429 (or any non-2xx) does today | Class | What the operator does |
| --- | --- | --- | --- | --- |
| Co-Pilot target, **turn** | 10 turns/min/conversation, 20K tokens/turn, 60K/conversation, 2M/day ([feature brief](../COPILOT_FEATURE.md)) | Treated as ambiguous: the case ends `incomplete` and the turn is **not** replayed, because the target may have applied it. Only `409` plus the not-applied header permits one retry with a new ticket | Abort (the case) | Re-run later. A case that ended this way is never counted `safe` |
| Co-Pilot target, **handshake** (readiness, login, chart, session, conversation) | Same target | A non-OK step blocks the case (for example "Target not ready"). An unavailable ticket or rejected document intent ends it `incomplete` | Abort (the case) | Re-run later |
| OpenRouter | Provider-side, not tracked | The call fails with no retry and no fallback (`allow_fallbacks: false`). If the request may have been sent, the call stays `unresolved`, which blocks further paid calls in that run until reconciled. A call proven unsent settles at zero | Abort (the call) | Reconcile the unresolved hold once, with provider evidence ([spend reconciliation](../implementation/spend-reconciliation.md)) |
| Ollama | None assumed (trusted LAN) | The call fails, no retry, no dollar price | Abort (the call) | Check the local model server |
| Optional evidence bridge | Off by default | One GET per accepted turn, no redirects; failure yields `unknown`, never a safe result | Abort (the read) | None |
| The auditor's own API | None (trusted LAN) | No rate limiting. JSON bodies capped at 32 KB, PDFs at 21 MB | n/a | Restrict the LAN |

**Classification.**

- **Backoff:** not implemented anywhere.
- **Queue:** the only queue is the run queue. Runs wait for the single worker, but a busy target rejects a second launch with `409` and a scheduled occurrence on a busy target is recorded as skipped. Neither is a rate-limit queue.
- **Abort:** everything else. The unit of work that saw the failure stops and is labeled `incomplete`, `blocked` or `unresolved`, never `safe`.

**Known exposure.** The auditor does not track the target's 2M-tokens-per-day budget. A large suite against a target whose daily budget is nearly spent would see non-2xx replies and end its cases `incomplete`; the auditor would not know why.

**Tracked optional hardening, not implemented.** Dedicated 429 handling (recognize the status, honor `Retry-After`, bounded backoff) is tracked under HDX-45 as optional. The operator chose to satisfy the requirement by documenting current behavior and to write no 429 or backoff code. Any future backoff must not replay a target turn except under the existing not-applied contract, and must not retry a paid call whose delivery is uncertain.

## 8. Gaps and proposed follow-ups

None of these was done in this change, which is documentation only.

1. **No `npm audit` in CI and no dependency-update automation** ([3.7](#37-how-the-inventory-is-kept-current)). Proposed: a scheduled and per-merge audit job.
2. **Images are unpinned and unscanned** (T4). Proposed: pin digests, scan built images.
3. **No SAST tool** ([4.3](#43-code-check-grep-heuristic)). The code check is a grep heuristic.
4. **Runtime image carries dev dependencies and runs `tsx`** (T1). Proposed: compile ahead of time, ship a production-only image.
5. **Stale sentence in `THREAT_MODEL.md`** about dependency scanning (T6).
6. **Postmortem action items AI-1 to AI-5** ([section 5](#prevention-and-action-items)): restart policy, API-side expiry sweep, external health polling, a runbook entry, and a check of worker behavior on a database restart.
7. **Dedicated 429 handling** ([section 7](#7-rate-limit-and-429-handling-policy)), optional.
8. **Standing gap from the submission index:** the PRD minimum of three discovered vulnerability reports is not met ([submission index](README.md)).

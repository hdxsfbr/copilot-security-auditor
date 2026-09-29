import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../apps/api/src/app.js';
import { storePdf } from '../apps/api/src/artifacts.js';
import { legacyRoles } from '../apps/worker/src/models.js';
import { database, users } from './support.js';
import { migrationNames } from '../db/migrate.js';

async function pdfBytes() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return Buffer.from(await pdf.save());
}

test('selected finding decisions recheck exact PDF bytes and retain historical approval after later loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auditor-integrity-'));
  process.env.ARTIFACT_DIR = dir;
  const db = await database();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).migrations, migrationNames.length);
    const target = await db.repo.target({ name: 'Integrity target', baseUrl: 'http://example.test/', ...users });
    const selected = await db.repo.createCase({ title: 'PDF evidence', user: 'A', expectedSafeBehavior: 'Keep the chart boundary', actions: [{ kind: 'chat_turn', message: 'read this' }] });
    const bytes = await pdfBytes();
    const artifact = await storePdf(db.repo, selected.id, 'lab_pdf', bytes);
    const definition = { title: 'PDF evidence', user: 'A' as const, expectedSafeBehavior: 'Keep the chart boundary', actions: [{ kind: 'attach_pdf' as const, message: 'read this', artifactId: artifact.id, documentType: 'lab_pdf' as const }] };
    await db.repo.updateCase(selected.id, definition);
    const started = await db.repo.start({ targetId: target.id, caseId: selected.id, model: 'stub', ollamaUrl: 'http://ollama.test/' });
    assert.ok(started && 'id' in started);
    const lease = await db.repo.claim('integrity-test');
    assert.equal(lease?.id, started.id);
    await db.repo.finish(started.id, lease!.lease_generation, 'pending_review');
    const candidate = (await db.repo.findings())[0];
    const path = join(dir, `${artifact.id}.pdf`);

    let response = await fetch(`${base}/findings/${candidate.id}/integrity`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'complete');
    assert.equal((await db.repo.findings())[0].evidenceIntegrity.status, 'complete');

    await rm(path);
    response = await post(`/findings/${candidate.id}/review`, { decision: 'confirm' });
    assert.equal(response.status, 409);
    const missing = await response.json();
    assert.deepEqual([missing.code, missing.reason, missing.integrity.status], ['conflict', 'evidence_integrity_failed', 'missing']);
    assert.deepEqual(missing.integrity.artifacts, [{ id: artifact.id, status: 'missing' }]);
    assert.equal((await db.repo.findings())[0].state, 'pending_review');
    assert.equal((await db.repo.findings())[0].evidenceIntegrity.status, 'missing');
    assert.equal((await db.repo.regressions()).length, 0);

    await writeFile(path, bytes);
    response = await post(`/findings/${candidate.id}/review`, { decision: 'confirm' });
    assert.equal(response.status, 200);
    assert.equal((await db.repo.findings())[0].state, 'confirmed');
    assert.equal((await db.repo.regressions()).length, 1);

    await writeFile(path, Buffer.alloc(bytes.length, 0x58));
    response = await post(`/findings/${candidate.id}/approve-export`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).integrity.status, 'corrupt');
    assert.equal((await db.repo.findings())[0].exportApprovedAt, null);
    await writeFile(path, bytes);
    response = await post(`/findings/${candidate.id}/approve-export`);
    assert.equal(response.status, 200);
    const approvedAt = (await db.repo.findings())[0].exportApprovedAt;
    assert.ok(approvedAt);

    await rm(path);
    response = await fetch(`${base}/findings/${candidate.id}/export`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).integrity.status, 'missing');
    assert.equal((await db.repo.findings())[0].state, 'confirmed');
    assert.equal((await db.repo.findings())[0].exportApprovedAt?.toISOString(), approvedAt.toISOString());
    await writeFile(path, bytes);
    response = await fetch(`${base}/findings/${candidate.id}/export`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).findingId, candidate.id);

    // A file lost after execution but before the worker's automatic decision
    // must produce review work, never an auto-confirmed regression.
    await rm(path);
    const later = await db.repo.start({ targetId: target.id, caseId: selected.id, model: 'stub', ollamaUrl: 'http://ollama.test/' });
    assert.ok(later && 'id' in later);
    const laterLease = await db.repo.claim('later-integrity-test');
    await db.repo.finish(later.id, laterLease!.lease_generation, 'auto_confirm');
    const laterFinding = (await db.repo.findings()).find(f => f.runId === later.id);
    assert.equal(laterFinding?.state, 'pending_review');
    assert.equal(laterFinding?.evidenceIntegrity.status, 'missing');
    assert.equal((await db.repo.run(later.id)).outcome, 'pending_review');
    assert.equal((await db.repo.regressions()).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.ARTIFACT_DIR;
  }
});

test('adaptive candidates check only their executed case attachments, not every seed or sibling case', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auditor-adaptive-integrity-'));
  process.env.ARTIFACT_DIR = dir;
  const db = await database();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const target = await db.repo.target({ name: 'Adaptive integrity', baseUrl: 'http://example.test/', ...users });
    const seed = await db.repo.createCase({ title: 'Seed with PDF', category: 'prompt_injection', user: 'A', expectedSafeBehavior: 'Keep the boundary', actions: [{ kind: 'chat_turn', message: 'first' }] });
    const bytes = await pdfBytes();
    const artifact = await storePdf(db.repo, seed.id, 'lab_pdf', bytes);
    const attached = { title: 'Seed with PDF', category: 'prompt_injection' as const, user: 'A' as const, expectedSafeBehavior: 'Keep the boundary', actions: [{ kind: 'attach_pdf' as const, message: 'read', artifactId: artifact.id, documentType: 'lab_pdf' as const }] };
    await db.repo.updateCase(seed.id, attached);
    const started = await db.repo.startAdaptive({ targetId: target.id, caseIds: [seed.id], categories: ['prompt_injection'], maxCases: 2, maxMinutes: 3, ollamaUrl: 'http://ollama.test/', roles: legacyRoles('stub') }, { roles: legacyRoles('stub'), pricing: {} });
    assert.ok(started && 'id' in started);
    const lease = await db.repo.claim('adaptive-integrity-test');
    assert.equal(lease?.id, started.id);
    const firstCase = await db.repo.beginAdaptiveCase(started.id, lease!.lease_generation, 1, 'prompt_injection', seed.id);
    await db.repo.executeAdaptiveCase(started.id, lease!.lease_generation, firstCase, attached);
    await rm(join(dir, `${artifact.id}.pdf`));
    assert.equal(await db.repo.completeAdaptiveCase(started.id, lease!.lease_generation, firstCase, 'auto_confirm', true), 'pending_review');
    const secondCase = await db.repo.beginAdaptiveCase(started.id, lease!.lease_generation, 2, 'prompt_injection', seed.id);
    await db.repo.executeAdaptiveCase(started.id, lease!.lease_generation, secondCase, { ...attached, actions: [{ kind: 'chat_turn', message: 'no attachment used' }] });
    assert.equal(await db.repo.completeAdaptiveCase(started.id, lease!.lease_generation, secondCase, 'auto_confirm', true), 'auto_confirm');
    await db.repo.finish(started.id, lease!.lease_generation, 'pending_review');
    const findings = await db.repo.pool.query('SELECT id,adaptive_case_id FROM candidates WHERE run_id=$1', [started.id]);
    const withPdf = findings.rows.find(row => row.adaptive_case_id === firstCase);
    const withoutPdf = findings.rows.find(row => row.adaptive_case_id === secondCase);
    assert.ok(withPdf && withoutPdf);

    let response = await fetch(`${base}/findings/${withPdf.id}/integrity`);
    assert.equal((await response.json()).status, 'missing');
    response = await fetch(`${base}/findings/${withoutPdf.id}/integrity`);
    assert.deepEqual(await response.json(), { status: 'complete', artifacts: [], checkedAt: (await db.repo.findings()).find(f => f.id === withoutPdf.id).evidenceIntegrity.checkedAt });
    response = await post(`/findings/${withoutPdf.id}/review`, { decision: 'confirm' });
    assert.equal(response.status, 200);
    response = await post(`/findings/${withoutPdf.id}/approve-export`);
    assert.equal(response.status, 200);
    response = await fetch(`${base}/findings/${withoutPdf.id}/export`);
    assert.equal(response.status, 200);
    response = await post(`/findings/${withPdf.id}/review`, { decision: 'confirm' });
    assert.equal(response.status, 409);
    assert.equal((await db.repo.findings()).find(f => f.id === withPdf.id).state, 'pending_review');
    assert.equal((await db.repo.findings()).find(f => f.id === withoutPdf.id).state, 'confirmed');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.ARTIFACT_DIR;
  }
});

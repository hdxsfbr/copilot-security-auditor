import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { launchFixtureBrowser } from './support.js';

const output = resolve('test-results/HDX-28/after');
const base = { targetName: 'Synthetic chart target', reportJobId: null, role: 'judge', model: 'fixture/paid-judge', ageSeconds: 7500 };
const calls = [
  { ...base, id: '11111111-1111-4111-8111-111111111111', runId: '21111111-1111-4111-8111-111111111111', reservedNanos: '2000000', reportedChargeNanos: '2500000', providerGenerationId: 'gen-1a2B3c4D5e', maxChargeNanos: '20000000' },
  { ...base, id: '12222222-2222-4222-8222-222222222222', runId: '22222222-2222-4222-8222-222222222222', role: 'documentation', model: 'fixture/paid-docs', reportJobId: '31111111-1111-4111-8111-111111111111', reservedNanos: '2200000', reportedChargeNanos: null, providerGenerationId: null, maxChargeNanos: '22000000', ageSeconds: 200000 },
];

// A synthetic API: the ledger is a small state machine so refetch after a recorded reconciliation is real.
async function fixture(page: import('playwright-core').Page, options: { failFirstSecond: boolean; delayMs: number }) {
  const open = [...calls];
  const posts: { path: string; body: Record<string, string> }[] = [];
  let reconciled = 0n, secondFailures = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue(); // Vite serves /src/api/* modules through the same glob
    const path = pathname.slice('/api'.length);
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (['/targets', '/cases', '/findings', '/regressions', '/coverage', '/schedules'].includes(path)) return respond([]);
    if (path === '/config') return respond({ ollamaUrl: 'http://127.0.0.1:11434', model: 'synthetic-local' });
    if (path === '/models') return respond({ openrouter: [], ollama: ['synthetic-local'], configured: false });
    if (path === '/spend/unresolved') {
      const held = open.reduce((sum, call) => sum + BigInt(call.reservedNanos), 0n);
      return respond({ v: 1, totals: { providerReportedNanos: '1500000', operatorReconciledNanos: reconciled.toString(), reservedNanos: '4000000', unresolvedNanos: held.toString(), unresolvedCalls: open.length }, calls: open, truncated: false, bounds: { maxChargeMultiple: 10, maxChargeNanos: '100000000000' } });
    }
    const match = /^\/spend\/calls\/([^/]+)\/reconcile$/.exec(path);
    if (match && request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}');
      posts.push({ path, body });
      if (options.delayMs) await new Promise(resolvePromise => setTimeout(resolvePromise, options.delayMs));
      if (options.failFirstSecond && match[1] === calls[1].id && secondFailures++ < 2) return respond({ v: 1, code: 'conflict', reason: 'not_unresolved', message: 'Only an unresolved paid call can be reconciled' }, 409);
      const index = open.findIndex(call => call.id === match[1]);
      if (index < 0) return respond({ message: 'Model call not found' }, 404);
      const chargeNanos = body.resolution === 'confirmed_not_billed' ? '0' : String(Math.round(Number(body.chargeUsd) * 1e9));
      reconciled += BigInt(chargeNanos);
      open.splice(index, 1);
      return respond({ v: 1, replayed: false, reconciliation: { id: '41111111-1111-4111-8111-111111111111', callId: match[1], resolution: body.resolution, chargeNanos, evidence: body.evidence }, call: { id: match[1], status: 'settled', chargeNanos } }, 201);
    }
    return respond({ message: `Unexpected synthetic request ${path}` }, 404);
  });
  return posts;
}

test('unresolved spend panel: separate totals, attested reconciliation form, no double submit, stable retry key', async () => {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  const browser = await launchFixtureBrowser();
  const capture = process.env.SPEND_CAPTURE_MEDIA === '1';
  if (capture) await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    const posts = await fixture(page, { failFirstSecond: true, delayMs: 350 });
    await page.goto(url, { waitUntil: 'networkidle' });
    const panel = page.getByRole('region', { name: 'Unresolved spend' });
    await panel.waitFor();
    const totals = panel.locator('dl[aria-label="Spend totals"]');
    const text = async () => (await totals.innerText()).replace(/\s+/g, ' ');
    assert.match(await text(), /Provider-reported \$0\.001500/);
    assert.match(await text(), /Operator-reconciled \$0\.000000/);
    assert.match(await text(), /Reserved in flight \$0\.004000/);
    assert.match(await text(), /Unresolved \(held\) \$0\.004200 · 2 calls/);
    const first = panel.locator('.spend-call').filter({ hasText: 'fixture/paid-judge' }), second = panel.locator('.spend-call').filter({ hasText: 'fixture/paid-docs' });
    assert.match(await first.innerText(), /Provider reported \$0\.002500, above the reserve/);
    assert.match(await first.innerText(), /gen-1a2B3c4D5e/);
    assert.match(await first.innerText(), /held 2 h 5 min/);
    assert.match(await second.innerText(), /No provider reference was recorded/);
    assert.match(await second.innerText(), /post-run report call/);
    assert.match(await second.innerText(), /held 2 d 7 h/);

    await first.getByRole('button', { name: 'Reconcile…' }).click();
    const form = first.getByRole('form', { name: 'Reconcile judge call' });
    await form.waitFor();
    assert.match(await form.innerText(), /This records an operator attestation/);
    assert.match(await form.innerText(), /cannot be edited/);
    const submit = form.getByRole('button', { name: 'Record reconciliation' });
    assert.equal(await submit.isDisabled(), true, 'nothing is recorded without evidence, a charge and an attestation');
    await form.getByLabel(/Evidence/).fill('OpenRouter activity row gen-1a2B3c4D5e');
    await form.getByLabel(/Charge in USD/).fill('0,0025');
    await page.getByText(/decimal dollar amount/).waitFor();
    assert.equal(await submit.isDisabled(), true);
    await form.getByLabel(/Charge in USD/).fill('0.0025');
    assert.equal(await submit.isDisabled(), true, 'the attestation checkbox is still required');
    if (capture) await page.screenshot({ path: join(output, 'desktop-spend-panel.png'), fullPage: true });
    await form.getByLabel(/I checked this against/).check();
    assert.equal(await submit.isEnabled(), true);
    await submit.dblclick();
    await panel.getByRole('status').filter({ hasText: /Recorded operator-attested charge \$0\.002500/ }).waitFor();
    assert.equal(posts.length, 1, 'a double click sends one request');
    assert.deepEqual(posts[0].body, { resolution: 'settled_by_operator', chargeUsd: '0.0025', evidence: 'OpenRouter activity row gen-1a2B3c4D5e', idempotencyKey: posts[0].body.idempotencyKey });
    assert.match(posts[0].body.idempotencyKey, /^[A-Za-z0-9._:-]{8,128}$/);
    await panel.getByText('fixture/paid-judge').waitFor({ state: 'detached' });
    assert.match(await text(), /Operator-reconciled \$0\.002500/);
    assert.match(await text(), /Provider-reported \$0\.001500/, 'operator-attested spend never merges into provider-reported');
    assert.match(await text(), /Unresolved \(held\) \$0\.002200 · 1 call\b/);

    await second.getByRole('button', { name: 'Reconcile…' }).click();
    const notBilled = second.getByRole('form', { name: 'Reconcile documentation call' });
    await notBilled.getByLabel('Resolution').selectOption('confirmed_not_billed');
    assert.equal(await notBilled.getByLabel(/Charge in USD/).count(), 0, 'confirmed not billed carries no amount');
    await notBilled.getByLabel(/Evidence/).fill('Provider dashboard shows no generation for this request');
    await notBilled.getByLabel(/I checked this against/).check();
    await notBilled.getByRole('button', { name: 'Record reconciliation' }).click();
    await notBilled.getByRole('alert').filter({ hasText: 'Only an unresolved paid call can be reconciled' }).waitFor();
    assert.equal(await notBilled.getByRole('button', { name: 'Record reconciliation' }).isEnabled(), true, 'a failure is recoverable in place');
    assert.equal(await second.count(), 1, 'a failed attempt leaves the call held');
    await notBilled.getByRole('button', { name: 'Record reconciliation' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.spend-call [role="alert"]').length === 1);
    await page.waitForTimeout(450);
    assert.equal(posts.length, 3);
    assert.equal(posts[2].body.idempotencyKey, posts[1].body.idempotencyKey, 'retrying the same request reuses its key');
    // A changed request is a new request: a fresh key avoids the server's idempotency conflict.
    await notBilled.getByLabel(/Evidence/).fill('Provider dashboard shows no generation; invoice line 42');
    await notBilled.getByRole('button', { name: 'Record reconciliation' }).click();
    await panel.getByRole('status').filter({ hasText: 'Recorded as confirmed not billed ($0).' }).waitFor();
    assert.equal(posts.length, 4);
    assert.notEqual(posts[3].body.idempotencyKey, posts[2].body.idempotencyKey);
    await panel.getByRole('status').filter({ hasText: 'No unresolved paid calls.' }).waitFor();
    assert.match(await text(), /Unresolved \(held\) \$0\.000000 · 0 calls/);
    assert.equal(pageErrors.length, 0, pageErrors.join("; "));

    const refreshed = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await refreshed.newPage();
    mobile.on('pageerror', error => pageErrors.push(error.message));
    await fixture(mobile, { failFirstSecond: false, delayMs: 0 });
    await mobile.goto(url, { waitUntil: 'networkidle' });
    const mobilePanel = mobile.getByRole('region', { name: 'Unresolved spend' });
    await mobilePanel.locator('.spend-call').filter({ hasText: 'fixture/paid-docs' }).getByRole('button', { name: 'Reconcile…' }).click();
    await mobilePanel.getByLabel(/Evidence/).fill('Invoice line 42 for the documentation request');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page scroll at 390px');
    if (capture) await mobile.screenshot({ path: join(output, 'mobile-spend-panel.png'), fullPage: true });
    await refreshed.close();
    assert.equal(pageErrors.length, 0, pageErrors.join("; "));
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});

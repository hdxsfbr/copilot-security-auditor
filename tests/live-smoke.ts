import { PDFDocument } from 'pdf-lib';
import { Session, type Identity } from '../apps/worker/src/session.js';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be explicitly supplied`);
  return value;
}

const baseUrl = new URL(required('SMOKE_TARGET_URL'));
if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new Error('SMOKE_TARGET_URL must be an explicit HTTP(S) URL without embedded credentials');
const cap = Number(required('SMOKE_CHARGE_CAP_USD'));
if (!Number.isFinite(cap) || cap <= 0 || cap > 1) throw new Error('SMOKE_CHARGE_CAP_USD must be greater than zero and at most 1 USD');
if (required('SMOKE_PROVIDER_CAP_CONFIRMED') !== 'true') throw new Error('Confirm an effective provider-side spend cap by setting SMOKE_PROVIDER_CAP_CONFIRMED=true');
const identity = (prefix: 'A' | 'B'): Identity => ({
  username: required(`SMOKE_USER_${prefix}`),
  password: required(`SMOKE_PASSWORD_${prefix}`),
  pubpid: required(`SMOKE_PUBPID_${prefix}`)
});
const a = identity('A'), b = identity('B');
if (a.username === b.username || a.pubpid === b.pubpid) throw new Error('Smoke identities must be distinct');

console.warn(`LIVE SMOKE: target=${baseUrl.origin}; operator-declared maximum possible provider charge=$${cap.toFixed(2)}. The cap must already be enforced by the target/provider; this tool cannot enforce downstream billing. Only proceed with operator-owned synthetic identities and toy data.`);
const sessionA = new Session(baseUrl.toString(), a);
const sessionB = new Session(baseUrl.toString(), b);
try {
  await sessionA.open();
  await sessionB.open();
  if (sessionA.assignedPid === sessionB.assignedPid) throw new Error('Synthetic identities resolved to the same chart');
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const sourceId = await sessionA.upload('lab_pdf', Buffer.from(await pdf.save()));
  const result = await sessionA.turn('Summarize this synthetic smoke-test document in one sentence.', 1, sourceId);
  console.log(JSON.stringify({ outcome: 'observed', targetVersion: sessionA.version, chartContextsDistinct: true, attachmentUploaded: true, turnStatus: result.observation.status, possibleChargeCapUsd: cap }));
} catch {
  console.error('Live smoke failed; details suppressed to avoid credential or response disclosure. Inspect target health and synthetic test setup, then start a new smoke explicitly.');
  process.exitCode = 1;
} finally {
  await sessionA.close();
  await sessionB.close();
}

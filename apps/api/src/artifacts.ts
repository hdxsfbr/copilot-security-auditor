import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Repository } from './repository.js';

const root = () => process.env.ARTIFACT_DIR ?? '/app/private-evidence';
export async function storePdf(repo: Repository, caseId: string, documentType: 'lab_pdf' | 'intake_form', bytes: Buffer) {
  const limit = documentType === 'lab_pdf' ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
  if (!bytes.length || bytes.length > limit || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF size or signature');
  let pages: number;
  try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: false })).getPageCount(); }
  catch { throw new Error('Invalid PDF'); }
  if (!pages || pages > (documentType === 'lab_pdf' ? 20 : 10)) throw new Error('PDF page limit exceeded');
  const id = randomUUID();
  await mkdir(root(), { recursive: true });
  const temporary = join(root(), `${id}.tmp`), final = join(root(), `${id}.pdf`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, final);
    await repo.addArtifact({ id, caseId, documentType, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, pages });
  } catch (e) { await rm(temporary, { force: true }); await rm(final, { force: true }); throw e; }
  return { id, documentType, bytes: bytes.length, pages };
}
export async function loadPdf(repo: Repository, caseId: string, id: string, documentType: string) {
  const ref = await repo.artifact(caseId, id, documentType);
  if (!ref) throw new Error('Artifact not linked to selected case');
  const bytes = await readFile(join(root(), `${id}.pdf`));
  if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('Artifact integrity failure');
  return bytes;
}

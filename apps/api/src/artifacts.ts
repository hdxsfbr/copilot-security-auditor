import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

export async function auditArtifactVolume(repo: Repository) {
  const refs = await repo.artifactRefs();
  const expected = new Set(refs.map(ref => `${ref.id}.pdf`));
  const files = await readdir(root()).catch(error => error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : Promise.reject(error));
  const orphaned = files.filter(file => !expected.has(file));
  const missing: string[] = [], corrupt: string[] = [];
  for (const ref of refs) {
    const path = join(root(), `${ref.id}.pdf`);
    try {
      const [metadata, bytes] = await Promise.all([lstat(path), readFile(path)]);
      if (!metadata.isFile() || bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) corrupt.push(ref.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(ref.id);
      else corrupt.push(ref.id);
    }
  }
  return { ok: orphaned.length === 0 && missing.length === 0 && corrupt.length === 0, orphaned, missing, corrupt };
}

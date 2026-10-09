import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PaperProject } from '../../shared/paper-types';
import { sceneSvg } from '../../shared/svg';
import { buildPdf, paperTex } from './export';
import { assertId } from './store';

// UI/method configuration and unaccepted candidates do not change the typeset paper.
export function previewFingerprint(p: PaperProject): string {
  const figures = p.modules.figures.assetIds.map(id => p.assets.find(a => a.id === id))
    .filter(a => !!a).map(a => [a.id, sceneSvg(a.scene)]);
  return createHash('sha256').update(JSON.stringify({ version: 1, language: p.language,
    source: paperTex(p), files: p.template?.files, figures,
    compiler: process.env.PAPER_PDFLATEX ?? 'pdflatex' })).digest('hex');
}

export function createPreviewBuilder(compile = buildPdf) {
  const pending = new Map<string, ReturnType<typeof buildPdf>>();
  return async (p: PaperProject, root: string) => {
    assertId(p.id);
    const fingerprint = previewFingerprint(p);
    const manifest = join(resolve(root), p.id, 'preview.json');
    try {
      const cached = JSON.parse(await readFile(manifest, 'utf8'));
      assertId(cached.id);
      if (cached.fingerprint === fingerprint && Array.isArray(cached.warnings)) {
        await access(join(root, p.id, 'builds', cached.id, 'main.pdf'));
        return { id: cached.id as string, revision: p.revision,
          warnings: cached.warnings as string[], cached: true };
      }
    } catch { /* Missing, incomplete, or obsolete previews are compiled again. */ }
    const key = `${resolve(root)}:${p.id}:${fingerprint}`;
    let task = pending.get(key);
    if (!task) {
      task = compile(structuredClone(p), root).then(async build => {
        await writeFile(manifest, JSON.stringify({ ...build, fingerprint }), 'utf8');
        return build;
      });
      pending.set(key, task);
      void task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => {});
    }
    const build = await task;
    return { ...build, revision: p.revision, cached: false };
  };
}

export const buildPreview = createPreviewBuilder();

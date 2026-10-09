import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPaper, newCandidate } from '../../shared/paper-project';
import { createPreviewBuilder, previewFingerprint } from '../../server/paper/preview';
import { markdownToTex } from '../../server/paper/export';

test('native table layout measures rich-text words, budgets padding, and keeps captions with rows', () => {
  const tex = markdownToTex('Table 1: Token costs.\n\n| Model | Dataset | Diagnosis input | Continuation output |\n|---|---|---|---|\n| **Qwen3-4B** | GSM8K | 1,036 | 1,142 |');
  assert.match(tex, /\\begin\{minipage\}\{\\linewidth\}/);
  assert.match(tex, /\\raggedright\\arraybackslash/);
  assert.match(tex, /\\textbf\{Qwen3-4B\}/);
  assert.match(tex, /1,036/);
  const columns = [...tex.matchAll(/([\d.]+)\\linewidth-([\d.]+)\\tabcolsep/g)];
  assert.equal(columns.length, 4);
  assert.ok(Math.abs(columns.reduce((sum, c) => sum + Number(c[1]), 0) - 1) < 0.0001);
  assert.ok(Math.abs(columns.reduce((sum, c) => sum + Number(c[2]), 0) - 8) < 0.0001);
});

test('preview fingerprint tracks accepted paper and template, not configuration or candidates', () => {
  const p = createPaper(randomUUID(), 'Paper', 'Idea');
  p.template = { name: 'Conference', entry: 'main.tex', files: [
    { name: 'main.tex', content: '\\documentclass{article}\n\\begin{document}' },
    { name: 'conference.sty', content: 'STYLE 1' }] };
  const base = previewFingerprint(p);
  p.modules.method.locked = true; p.modules.method.model = 'different'; p.revision++;
  p.candidates.push(newCandidate(p, randomUUID(), randomUUID(), 'method', 'grounded-section', 'test', { content: 'Unaccepted content', warnings: [] }));
  assert.equal(previewFingerprint(p), base);
  p.modules.method.content = 'Accepted content';
  assert.notEqual(previewFingerprint(p), base);
  p.modules.method.content = '';
  p.template.files[1].content = 'STYLE 2';
  assert.notEqual(previewFingerprint(p), base);
});

test('preview coalesces concurrent requests and reuses the PDF across process restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-preview-test-'));
  const p = createPaper(randomUUID(), 'Paper', 'Idea');
  let calls = 0;
  const compile = async (paper: typeof p, destination: string) => {
    calls++;
    const id = randomUUID(), dir = join(destination, paper.id, 'builds', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'main.pdf'), '%PDF-test');
    return { id, revision: paper.revision, warnings: [] };
  };
  try {
    const build = createPreviewBuilder(compile);
    const [a, b] = await Promise.all([build(p, root), build(p, root)]);
    assert.equal(a.id, b.id); assert.equal(calls, 1);
    p.revision++;
    const c = await createPreviewBuilder(compile)(p, root);
    assert.equal(c.id, a.id); assert.equal(c.cached, true); assert.equal(c.revision, p.revision);
    assert.equal(calls, 1);
    await unlink(join(root, p.id, 'builds', c.id, 'main.pdf'));
    const d = await build(p, root);
    assert.notEqual(d.id, c.id); assert.equal(calls, 2);
    p.modules.introduction.content = 'Revised introduction';
    assert.notEqual((await build(p, root)).id, d.id); assert.equal(calls, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed compilation is not cached and can be retried', async () => {
  const p = createPaper(randomUUID(), 'Paper', 'Idea');
  let calls = 0;
  const build = createPreviewBuilder(async () => { calls++; throw Error('Missing style'); });
  await assert.rejects(build(p, join(tmpdir(), 'nonexistent-preview-root')), /Missing style/);
  await assert.rejects(build(p, join(tmpdir(), 'nonexistent-preview-root')), /Missing style/);
  assert.equal(calls, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPaper, acceptCandidates, saveModule, validateCandidate } from '../../shared/paper-project';
import type { ModuleId, ModuleInput, PaperRun } from '../../shared/paper-types';
import { runFailureMessage, runStatusLabel, validateResumeCandidate } from '../../shared/paper-run';
import { PaperStore } from '../../server/paper/store';
import { generatePaperRun } from '../../server/paper/generation';

async function fixture(t: import('node:test').TestContext, mode: PaperRun['mode'] = 'draft') {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'paper-generation-'));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    assert.ok(root.startsWith(join(parent, 'paper-generation-')));
    await rm(root, { recursive: true, force: true });
  });
  const store = new PaperStore(root);
  const baseline = createPaper(randomUUID(), 'QA isolated generation', 'A supplied research idea.');
  await store.save(baseline);
  const modules: ModuleId[] = mode === 'module' ? ['figures'] :
    ['outline', 'references', 'method', 'experiments', 'figures', 'related_work', 'introduction', 'abstract', 'conclusion'];
  const run: PaperRun = { id: randomUUID(), projectId: baseline.id, baseProjectRevision: baseline.revision,
    mode, status: 'running', createdAt: new Date().toISOString(), candidateIds: [], events: [],
    configuration: { modules, methods: Object.fromEntries(modules.map(id => [id, id === 'figures' ? 'publication-figures' : 'test'])),
      models: Object.fromEntries(modules.map(id => [id, 'test-no-api'])), instruction: '', skipReferenceSearch: false, reviewRounds: 0 } };
  const controller = new AbortController();
  const calls: ModuleId[] = [];
  const services = {
    execute: async (input: ModuleInput) => {
      calls.push(input.moduleId);
      if (input.moduleId === 'figures') throw Error('mod_diagnosis: Error: Label text_model does not fit container text_model_container');
      return { content: `Saved ${input.moduleId}`, warnings: [] };
    },
    review: async () => ({ rounds: 0, summary: 'QA review', issues: [] as { moduleId: ModuleId; severity: string; message: string }[] }),
    revise: async () => { throw Error('Unexpected review revision'); },
  };
  const log = (stage: string, message: string) => run.events.push({ stage, message, time: new Date().toISOString() });
  return { store, baseline, run, controller, calls, services, log,
    input: { store, baseline, run, signal: controller.signal, completed: [], model: 'test-no-api', log } };
}

test('a failed parallel figure preserves eight candidates and continues every prose module', async t => {
  const f = await fixture(t);
  await generatePaperRun(f.input, f.services);
  const p = await f.store.load(f.baseline.id);
  assert.equal(f.run.status, 'partial');
  assert.equal(f.run.candidateIds.length, 8);
  assert.ok(['introduction', 'abstract', 'conclusion'].every(id => p.candidates.some(c => c.moduleId === id)));
  assert.ok(!p.candidates.some(c => c.moduleId === 'figures'));
  assert.equal(f.calls.filter(id => id === 'figures').length, 1);
  assert.ok(Object.values(p.modules).every(m => m.content === ''));
  assert.deepEqual((await f.store.loadRun(f.run.id)).moduleFailures, f.run.moduleFailures);
  assert.equal(runStatusLabel(f.run), '正文已生成 · 绘图待重试');
});

test('resuming a partial run retries only the figure and retains candidate IDs and original prose', async t => {
  const f = await fixture(t);
  await generatePaperRun(f.input, f.services);
  const p = await f.store.load(f.baseline.id), before = structuredClone(p.candidates);
  p.candidates.forEach(c => validateCandidate(p, c));
  f.calls.length = 0;
  f.run.status = 'running';
  await generatePaperRun({ ...f.input, baseline: p, completed: p.candidates }, { ...f.services,
    execute: async input => { f.calls.push(input.moduleId); return { content: 'Repaired figure', warnings: [] }; } });
  const after = await f.store.load(p.id);
  assert.deepEqual(f.calls, ['figures']);
  assert.deepEqual(after.candidates.slice(0, 8), before);
  assert.equal(f.run.status, 'complete');
  assert.equal(f.run.candidateIds.length, 9);
  assert.deepEqual(f.run.moduleFailures, []);
});

test('accepted partial prose can be reused but subsequent manual edits block stale resume', async t => {
  const f = await fixture(t);
  await generatePaperRun(f.input, f.services);
  const p = await f.store.load(f.baseline.id);
  acceptCandidates(p, p.candidates.map(c => c.id), true);
  p.candidates.forEach(c => validateResumeCandidate(p, c));
  await f.store.save(p);
  const before = structuredClone(p);
  f.calls.length = 0;
  await generatePaperRun({ ...f.input, baseline: p, completed: p.candidates }, { ...f.services,
    execute: async input => { f.calls.push(input.moduleId); return { content: 'Repaired figure', warnings: [] }; } });
  const after = await f.store.load(p.id);
  assert.deepEqual(after.modules, before.modules);
  assert.deepEqual(after.candidates.slice(0, 8), before.candidates);
  assert.deepEqual(f.calls, ['figures']);
  const intro = p.candidates.find(c => c.moduleId === 'introduction')!;
  saveModule(p, 'introduction', p.modules.introduction.revision, 'Human revision');
  assert.throws(() => validateResumeCandidate(p, intro), /已变化/);
});

test('failed figures are not sent to a prose revision adapter during manuscript review', async t => {
  const f = await fixture(t);
  f.run.configuration!.reviewRounds = 3;
  await generatePaperRun(f.input, { ...f.services,
    review: async () => ({ rounds: 0, summary: 'Missing diagram remains explicit',
      issues: [{ moduleId: 'figures', severity: 'high', message: 'Missing overview' }] }) });
  assert.equal(f.run.status, 'partial');
  assert.equal(f.run.review?.issues.length, 1);
});

test('single-module figure failures and prose failures remain fatal', async t => {
  const single = await fixture(t, 'module');
  await assert.rejects(generatePaperRun(single.input, single.services), /Label text_model/);
  const full = await fixture(t);
  await assert.rejects(generatePaperRun(full.input, { ...full.services,
    execute: async () => { throw Error('HTTP 403: unavailable model'); } }), /HTTP 403/);
  assert.deepEqual(full.run.moduleFailures, []);
});

test('cancellation does not launch a figure or continue generating prose', async t => {
  const f = await fixture(t);
  f.controller.abort();
  await assert.rejects(generatePaperRun(f.input, f.services), /任务已取消/);
  assert.deepEqual(f.calls, []);
});

test('layout failures have actionable messages and API keys are redacted', () => {
  assert.match(runFailureMessage(Error('Label title cannot fit module 200 × 100')), /文字框空间不足/);
  assert.equal(runFailureMessage(Error('API failed sk-or-v1-123456')), 'API failed [redacted]');
});

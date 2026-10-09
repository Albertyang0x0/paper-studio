import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptCandidates, createPaper, newCandidate, replaceSources, restoreModule,
  saveModule, validateCandidate } from '../../shared/paper-project';
import { moduleOrder, type Candidate, type ModuleId } from '../../shared/paper-types';
import { validateResumeCandidate } from '../../shared/paper-run';

function family() {
  const p = createPaper(randomUUID(), 'QA split candidate acceptance', 'Supplied idea');
  const run = randomUUID();
  const proposals = moduleOrder.map(id => newCandidate(p, randomUUID(), run, id, p.modules[id].methodId,
    'test-no-api', { content: `Generated ${id}`, warnings: [] }));
  p.candidates.push(...proposals);
  const c = Object.fromEntries(proposals.map(c => [c.moduleId, c])) as Record<ModuleId, Candidate>;
  return { p, c };
}

test('intro and outline accepted separately do not invalidate the remaining seven batch candidates', () => {
  const { p, c } = family();
  acceptCandidates(p, [c.introduction.id]);
  acceptCandidates(p, [c.outline.id]);
  assert.deepEqual(p.modules.introduction.needsSync, []);
  const before = structuredClone({ outline: p.modules.outline, introduction: p.modules.introduction });
  const pending = p.candidates.filter(c => c.status === 'pending');
  assert.equal(pending.length, 7);
  acceptCandidates(p, pending.map(c => c.id), true);
  assert.deepEqual(p.modules.outline, before.outline);
  assert.deepEqual(p.modules.introduction, before.introduction);
  assert.ok(p.candidates.every(c => c.status === 'accepted'));
  assert.ok(Object.values(p.modules).every(m => m.revision === 1 && m.needsSync.length === 0));
});

test('forward and reverse single-candidate acceptance orders preserve batch dependencies', () => {
  for (const order of [moduleOrder, [...moduleOrder].reverse()]) {
    const { p, c } = family();
    for (const id of order) acceptCandidates(p, [c[id].id]);
    assert.ok(Object.values(p.modules).every(m => m.revision === 1 && m.needsSync.length === 0));
  }
});

test('a mixed accepted/pending family is valid for resuming without regeneration', () => {
  const { p, c } = family();
  acceptCandidates(p, [c.outline.id]);
  p.candidates.forEach(c => validateResumeCandidate(p, c));
});

test('editing an already accepted upstream chapter keeps downstream candidates stale and acceptance atomic', () => {
  const { p, c } = family();
  acceptCandidates(p, [c.outline.id]);
  saveModule(p, 'outline', 1, 'A different scientific plan');
  const before = structuredClone(p);
  assert.throws(() => acceptCandidates(p, p.candidates.filter(c => c.status === 'pending').map(c => c.id), true), /论文规划.*已变化/);
  assert.deepEqual(p, before);
});

test('a later manual edit is not accepted as unchanged even if the text equals the AI candidate', () => {
  const { p, c } = family();
  acceptCandidates(p, [c.outline.id]);
  saveModule(p, 'outline', 1, c.outline.content);
  assert.throws(() => validateCandidate(p, c.method), /论文规划.*已变化/);
});

test('restoring the original accepted prose does not disguise intervening upstream edits', () => {
  const { p, c } = family();
  acceptCandidates(p, [c.outline.id]);
  saveModule(p, 'outline', 1, 'Human plan');
  restoreModule(p, 'outline', 2, 1);
  assert.equal(p.modules.outline.content, c.outline.content);
  assert.throws(() => validateCandidate(p, c.method), /论文规划.*已变化/);
});

test('equal prose accepted from a different generation is not a same-batch dependency', () => {
  const { p, c } = family();
  const alternate = newCandidate(p, randomUUID(), randomUUID(), 'outline', 'orchestra-outline',
    'test-no-api', { content: c.outline.content, warnings: [] });
  p.candidates.push(alternate);
  acceptCandidates(p, [alternate.id]);
  assert.throws(() => validateCandidate(p, c.method), /论文规划.*已变化/);
});

test('changed materials are still blocked after a same-batch upstream commit', () => {
  const { p, c } = family();
  acceptCandidates(p, [c.outline.id]);
  replaceSources(p, p.revision, { title: p.title, ideaSpark: 'Updated evidence', materials: [],
    language: p.language, guidelines: p.guidelines });
  assert.throws(() => validateCandidate(p, c.method), /研究材料已变化/);
});

test('editing the target chapter still blocks a late candidate after its upstream is accepted', () => {
  const { p, c } = family();
  acceptCandidates(p, [c.outline.id]);
  saveModule(p, 'method', 0, 'Human-authored method');
  const before = structuredClone(p);
  assert.throws(() => acceptCandidates(p, [c.method.id]), /当前章节已被编辑/);
  assert.deepEqual(p, before);
});

test('edited upstream candidates do not silently validate already generated downstream prose', () => {
  for (const explicitProvenance of [true, false]) {
    const { p, c } = family();
    const edited: Candidate = { ...structuredClone(c.outline), id: randomUUID(), content: 'Researcher-edited plan',
      ...(explicitProvenance ? { editedFromCandidateId: c.outline.id } : {}) };
    c.outline.status = 'rejected';
    p.candidates.push(edited);
    const before = structuredClone(p);
    assert.throws(() => acceptCandidates(p, [edited.id, c.method.id], true), /论文规划.*已被编辑/);
    assert.deepEqual(p, before);
    acceptCandidates(p, [edited.id]);
    assert.throws(() => validateCandidate(p, c.method), /论文规划.*已变化/);
    // A newly generated dependent uses the actual committed upstream revision.
    const fresh = newCandidate(p, randomUUID(), randomUUID(), 'method', 'grounded-section',
      'test-no-api', { content: 'Method grounded in the new plan', warnings: [] });
    p.candidates.push(fresh);
    assert.doesNotThrow(() => validateCandidate(p, fresh));
  }
});

test('same-run candidates do not bypass original dependency revision checks', () => {
  const { p, c } = family();
  saveModule(p, 'outline', 0, 'New initial context');
  const later = newCandidate(p, randomUUID(), c.method.runId, 'outline', 'orchestra-outline',
    'test-no-api', { content: 'New generation against context v1', warnings: [] });
  p.candidates.push(later);
  acceptCandidates(p, [later.id]);
  assert.throws(() => validateCandidate(p, c.method), /论文规划.*已变化/);
});

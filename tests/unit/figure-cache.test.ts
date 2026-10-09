import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { figureJobDirectory } from '../../server/paper/figure-cache';

const input = { material: [{ id: 'idea', name: 'idea.md', content: 'Source mechanism' }],
  model: 'test-no-api', instruction: '' };
async function root(t: import('node:test').TestContext) {
  const parent = resolve(tmpdir()), dir = await mkdtemp(join(parent, 'figure-cache-test-'));
  t.after(async () => {
    assert.equal(dirname(dir), parent);
    assert.ok(dir.startsWith(join(parent, 'figure-cache-test-')));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('outline candidate changes do not invalidate source-grounded visual checkpoints', async t => {
  const dir = await root(t);
  const first = await figureJobDirectory(dir, input);
  await mkdir(first);
  assert.equal(await figureJobDirectory(dir, { ...input, outline: { title: 'Recovered outline' } }), first);
});

test('legacy parallel-figure checkpoints remain reusable after outline recovery', async t => {
  const dir = await root(t);
  const hash = createHash('sha256').update(JSON.stringify({ material: input.material,
    model: input.model, instruction: input.instruction, version: 2 })).digest('hex').slice(0, 20);
  const legacy = join(dir, hash);
  await mkdir(legacy);
  assert.equal(await figureJobDirectory(dir, { ...input, outline: { title: 'Recovered outline' } }), legacy);
});

test('changed scientific materials, models and instructions invalidate visual caches', async t => {
  const dir = await root(t), first = await figureJobDirectory(dir, input);
  await mkdir(first);
  for (const next of [
    { ...input, material: [{ ...input.material[0], content: 'Changed mechanism' }] },
    { ...input, model: 'different-model' },
    { ...input, instruction: 'Different figure scope' },
  ]) assert.notEqual(await figureJobDirectory(dir, next), first);
});

test('visual reconstruction uses a distinct cache keyed by algorithm and image model',async t=>{
  const dir=await root(t),legacy=await figureJobDirectory(dir,input);await mkdir(legacy);
  const modern={...input,pipeline:'visual-reconstruction-v1',imageModel:'test/image'};
  const current=await figureJobDirectory(dir,modern);assert.notEqual(current,legacy);
  assert.equal(await figureJobDirectory(dir,{...modern,outline:{title:'Changed outline'}}),current);
  assert.notEqual(await figureJobDirectory(dir,{...modern,imageModel:'other/image'}),current);
});

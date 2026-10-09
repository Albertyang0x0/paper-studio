import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { isPrivatePath, isSourcePath, collectSourceFiles, scanForCredentials } from '../../scripts/package-source.mjs';
import { bundledReferenceImages } from '../../server/model';

test('source package includes hidden GitHub setup but excludes credentials, research outputs and references', () => {
  for (const path of ['.gitignore', '.env.example', '.gitattributes', '.node-version', '.github/workflows/checks.yml',
    'vendor/paper-orchestra/LICENSE', 'server/index.ts', 'examples/demo/inputs/idea.md']) assert.equal(isSourcePath(path), true, path);
  for (const path of ['.env.local', '.local/api-settings.json', 'outputs/papers/project.json', 'archives/run.json',
    'node_modules/lib/index.js', 'dist/index.html', 'releases/source.zip', 'tests/browser/__pycache__/test.pyc',
    'public/references/trajectory.png', 'docs/WORKBENCH_VALIDATION.md', 'scripts/iterate-visual.ts', '../README.md']) assert.equal(isSourcePath(path), false, path);
  assert.equal(isPrivatePath('outputs\\papers\\private.json'), true);
});
test('source credential scan rejects common tokens and configured custom keys without echoing them', () => {
  const credential = 'sk-or-v1-' + 'a'.repeat(64), custom = 'local-custom-credential-fixture';
  for (const secret of [credential, custom]) {
    assert.throws(() => scanForCredentials([{ path: 'server/unsafe.ts', bytes: Buffer.from(secret) }], [custom]), error => {
      assert.ok((error as Error).message.includes('server/unsafe.ts')); assert.ok(!(error as Error).message.includes(secret)); return true;
    });
  }
  scanForCredentials([{ path: 'tests/unit/fixture.ts', bytes: Buffer.from('sk-or-v1-' + 'test-only-credential'.repeat(3)) }]);
});
test('source collection is independent of outputs, dependencies and the parent research directory', async t => {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'paper-source-policy-'));
  t.after(async () => { assert.equal(dirname(root), parent); assert.ok(root.startsWith(join(parent, 'paper-source-policy-'))); await rm(root, { recursive: true, force: true }); });
  for (const path of ['README.md', '.gitignore', '.env.example', '.env.local', '.github/workflows/checks.yml',
    'server/index.ts', 'outputs/papers/project.json', 'public/references/trajectory.png']) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), 'fixture only');
  }
  const files = await collectSourceFiles(root);
  assert.deepEqual(files.map(file => file.path).sort(), ['.env.example', '.github/workflows/checks.yml', '.gitignore', 'README.md', 'server/index.ts'].sort());
});
test('missing private reference images do not prevent the image-to-vector pipeline from starting', async t => {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'paper-reference-policy-'));
  t.after(async () => { assert.equal(dirname(root), parent); assert.ok(root.startsWith(join(parent, 'paper-reference-policy-'))); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await bundledReferenceImages(root), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

test('Paper Studio entrypoints, package metadata and organised paths agree', async () => {
  const root = process.cwd();
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.name, 'paper-studio');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(pkg.scripts.test, 'tsx --test tests/unit/*.test.ts');
  assert.equal(pkg.scripts['test:ui'], 'node scripts/test-ui.mjs');
  for (const path of ['src/paper/PaperWorkbench.tsx', 'src/paper/template-upload.ts',
    'src/figure/FigureEditor.tsx', 'src/figure/CanvasEditor.tsx', 'src/styles/theme.css',
    'scripts/test-ui.mjs', 'scripts/inspect-pdf-preview.py', 'tests/browser/workbench_browser.py',
    'docs/WORKBENCH.md', 'docs/MODULE_CONTRACT.md', 'docs/THIRD_PARTY_NOTICES.md']) {
    await access(resolve(root, path));
  }
  assert.match(await readFile(resolve(root, 'index.html'), 'utf8'), /<title>Paper Studio<\/title>/);
  const main = await readFile(resolve(root, 'src/main.tsx'), 'utf8');
  assert.match(main, /\.\/paper\/PaperWorkbench/);
  assert.match(main, /\.\/figure\/FigureEditor/);
  const config = JSON.parse(await readFile(resolve(root, 'tsconfig.json'), 'utf8'));
  assert.ok(config.exclude.includes('archives'));
});

test('the README links to existing local documents', async () => {
  const root = process.cwd();
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  for (const match of readme.matchAll(/\]\((docs\/[^)]+)\)/g)) {
    await access(resolve(root, match[1]));
  }
});

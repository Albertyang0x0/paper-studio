// Closing a board preserves files/server history and never invokes a model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(process.env.PAPER_TEST_NODE_MODULES
  ? join(resolve(process.env.PAPER_TEST_NODE_MODULES), '__close_browser_test__.cjs') : import.meta.url);
let chromium, expect;
try {
  ({ chromium } = require('playwright'));
  ({ expect } = require('playwright/test'));
} catch {
  throw Error('Close-project tests need Playwright. Set PAPER_TEST_NODE_MODULES to an existing node_modules directory containing playwright.');
}
const base = process.env.PAPER_TEST_BASE_URL ?? 'http://localhost:8788';
assert.ok(process.env.PAPER_TEST_ROOT, 'Run through scripts/test-ui.mjs to isolate test data');
const qa = join(process.env.PAPER_TEST_ROOT, 'qa');
await mkdir(qa, { recursive: true });
const status = await fetch(base + '/api/status').then(response => response.json());
assert.equal(status.dataScope, 'test', 'Refusing to run against a live data store');
const edge = join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const executablePath = process.env.PAPER_TEST_BROWSER ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const storageKey = 'paper-atelier-v1', errors = [], forbidden = [], recentReads = [];
const runId = randomUUID(), run = { finished: false, polls: 0 };
const config = { planner: 'fixture/retained-planner', reviewRounds: 2 };
const scene = {
  schema: 'paper-atelier/1', id: randomUUID(), title: 'Close project fixture', width: 600, height: 320,
  style: { font: 'Arial', ink: '#222222', muted: '#666666', accent: '#2266aa', palette: ['#e7f0f7'], lineWidth: 2, bodySize: 22, titleSize: 24, illustrationStyle: 'native' },
  materials: [{ id: 'research-fixture', name: 'notes.txt', content: 'Fixture research notes.' }],
  regions: [], annotations: [], connectors: [],
  modules: [{ id: 'visible', title: 'Editable fixture', role: 'structure', brief: 'Native test objects.', x: 120, y: 100, width: 360, height: 120, contentWidth: 360, contentHeight: 120,
    componentIds: [], sourceRefs: ['notes.txt'], labels: ['Original label'], ports: [], method: 'vector-agent', status: 'ready', elements: [
      { id: 'card', type: 'rect', x: 0, y: 0, width: 360, height: 120, radius: 10, fill: '#e7f0f7' },
      { id: 'label', type: 'text', x: 35, y: 48, text: 'Original label', fontSize: 22, fill: '#222222' },
    ] }],
  review: { status: 'reviewed', summary: 'Fixture review to clear.', issues: [] },
};
async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  await context.route('**/api/status', route => route.fulfill({ json: { ...status, configured: true } }));
  await context.route('**/api/models**', route => route.fulfill({ json: { models: [] } }));
  await context.route('**/api/projects', route => route.fulfill({ json: { projects: [{ id: scene.id }] } }));
  await context.route('**/api/projects/*', route => {
    recentReads.push(route.request().url());
    return route.fulfill({ json: scene });
  });
  for (const pattern of ['**/api/runs**', '**/api/paper-runs**']) await context.route(pattern, route => {
    forbidden.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: 'Model calls forbidden in close-project test' } });
  });
  return context;
}
async function importJson(scope, value = scene) {
  await scope.locator('input[type=file][accept=".json"]').setInputFiles({ name: 'same-project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await expect(scope.locator('.editor-title')).toHaveText(value.title);
  await expect(scope.locator('[data-layer-module]')).toHaveCount(1);
}
async function selectText(scope, label) {
  await scope.locator('[data-layer-module="visible"]').click();
  await scope.locator('.layer-elements button').filter({ hasText: label }).click();
  return scope.getByLabel('文字', { exact: true });
}
async function exportJson(page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'JSON 可编辑项目', exact: true }).click();
  return JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
}
async function openClose(scope) {
  await scope.getByRole('button', { name: '关闭项目', exact: true }).click();
  const dialog = scope.getByRole('dialog', { name: '关闭当前项目', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function directlyClose(scope) {
  const dialog = await openClose(scope);
  await dialog.getByRole('button', { name: '直接关闭', exact: true }).click();
}
async function assertEmpty(scope) {
  await expect(scope.getByRole('heading', { name: '新建图表', exact: true })).toBeVisible();
  await expect(scope.locator('[data-layer-module]')).toHaveCount(0);
  for (const name of ['关闭项目', '导出']) await expect(scope.getByRole('button', { name, exact: true })).toBeDisabled();
  for (const title of ['撤销 Ctrl+Z', '重做 Ctrl+Shift+Z']) await expect(scope.getByTitle(title, { exact: true })).toBeDisabled();
  for (const selector of ['.review-card', '.blueprint-preview', '.error-banner']) await expect(scope.locator(selector)).toHaveCount(0);
  await expect(scope.getByLabel('文字', { exact: true })).toHaveCount(0);
  await expect(scope.locator('.board-status')).toContainText('0 个模块');
  // An overlay alone could hide a stale Fabric scene. Require a cleared canvas.
  await expect.poll(() => scope.locator('canvas.lower-canvas').evaluate(canvas => {
    if (!canvas.width || !canvas.height) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 4; i < pixels.length; i++) if (pixels[i] !== pixels[i % 4]) return false;
    return true;
  })).toBe(true);
}
async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

const context = await newContext(), page = await context.newPage();
try {
  await context.route('**/api/runs/' + runId, route => {
    run.polls++;
    return route.fulfill({ json: { id: runId, status: run.finished ? 'complete' : 'running', scene,
      events: [{ id: 'event', stage: 'critic', status: 'complete', message: 'Fixture generation event to clear.', time: '2026-10-12T00:00:00Z' }] } });
  });
  await page.addInitScript(({ key, saved }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(saved));
  }, { key: storageKey, saved: { scene, materials: scene.materials, runId, config, intent: 'Fixture requirement', chosenRefs: ['multi-panel'] } });
  await page.goto(base + '/figure', { waitUntil: 'networkidle' });
  const close = page.getByRole('button', { name: '关闭项目', exact: true });
  await expect(close).toBeDisabled();
  assert.ok(run.polls > 0);
  run.finished = true;
  await expect(close).toBeEnabled({ timeout: 15000 });
  let text = await selectText(page, 'Original label');
  await text.fill('Saved edit before closing');
  await expect(page.getByTitle('撤销 Ctrl+Z', { exact: true })).toBeEnabled();
  let dialog = await openClose(page);
  const dialogScreenshot = process.env.PAPER_TEST_CLOSE_SCREENSHOT ?? join(qa, 'close-project-dialog.png');
  await mkdir(dirname(resolve(dialogScreenshot)), { recursive: true });
  await page.screenshot({ path: dialogScreenshot });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(text).toHaveValue('Saved edit before closing');
  dialog = await openClose(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(text).toHaveValue('Saved edit before closing');

  // Failure to persist the sentinel must not discard the scene or its history.
  const beforeFailure = await exportJson(page);
  await page.evaluate(key => {
    window.closeTestStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Fixture quota exceeded', 'QuotaExceededError');
      return window.closeTestStorageSetItem.call(this, name, value);
    };
  }, storageKey);
  dialog = await openClose(page);
  await dialog.getByRole('button', { name: '直接关闭', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-layer-module]')).toHaveCount(1);
  await page.evaluate(() => { Storage.prototype.setItem = window.closeTestStorageSetItem; delete window.closeTestStorageSetItem; });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await exportJson(page), beforeFailure, 'Failed persistence discarded the open scene');
  await expect(page.getByTitle('撤销 Ctrl+Z', { exact: true })).toBeEnabled();

  dialog = await openClose(page);
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出 JSON 并关闭', exact: true }).click();
  const download = await downloading;
  assert.ok(download.suggestedFilename().endsWith('.json'));
  const downloaded = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.deepEqual(downloaded, beforeFailure, 'Close-time download lost current edits');
  const closed = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.equal(closed.projectClosed, true);
  assert.ok(!closed.scene && !closed.runId && !closed.materials?.length, JSON.stringify(closed));
  assert.deepEqual(closed.chosenRefs, ['multi-panel', 'nested-memory', 'trajectory']);
  assert.equal(closed.config.planner, config.planner);
  await assertEmpty(page);
  await page.getByRole('button', { name: '运行记录', exact: true }).click();
  await expect(page.getByText('暂无运行记录。', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture generation event to clear.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '运行记录', exact: true }).click();

  // Reopen, leave a redo entry, then reload immediately after direct close.
  await importJson(page);
  text = await selectText(page, 'Original label');
  await text.fill('Discarded edit');
  await page.getByTitle('撤销 Ctrl+Z', { exact: true }).click();
  await expect(page.getByTitle('重做 Ctrl+Shift+Z', { exact: true })).toBeEnabled();
  await directlyClose(page);
  await page.reload({ waitUntil: 'networkidle' });
  await assertEmpty(page);
  assert.deepEqual(recentReads, [], 'A refresh reopened the recently closed server project');
  await page.screenshot({ path: join(qa, 'closed-empty-board.png') });
  await importJson(page, downloaded);
  text = await selectText(page, 'Saved edit before closing');
  await text.fill('Reopened project remains editable');
  await page.waitForFunction(key => {
    const saved = JSON.parse(localStorage.getItem(key));
    return saved.projectClosed !== true && saved.scene?.modules?.[0]?.elements?.[1]?.text === 'Reopened project remains editable';
  }, storageKey);
  await directlyClose(page);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><title>Reopened SVG</title><text x="10" y="40">SVG after close</text></svg>';
  await page.getByLabel('直接解析 SVG 项目', { exact: true }).setInputFiles({ name: 'reopened.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect(page.locator('.editor-title')).toHaveText('Reopened SVG');
  await expect(close).toBeEnabled();
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).projectClosed !== true, storageKey);

  // Hold a startup latest-project read until import and close have both finished.
  const delayedContext = await newContext(), delayedPage = await delayedContext.newPage();
  let signalRequested, release, signalSettled;
  const requested = new Promise(resolve => { signalRequested = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const settled = new Promise(resolve => { signalSettled = resolve; });
  await delayedContext.route('**/api/projects/*', async route => {
    signalRequested();
    await released;
    try { await route.fulfill({ json: scene }); } catch { /* Import may abort stale reads. */ }
    finally { signalSettled(); }
  });
  await delayedPage.goto(base + '/figure', { waitUntil: 'domcontentloaded' });
  await requested;
  await importJson(delayedPage);
  await directlyClose(delayedPage);
  release();
  await settled;
  await delayedPage.waitForLoadState('networkidle');
  await assertEmpty(delayedPage);
  await delayedContext.close();

  // All paper mutations below create deterministic fixtures in this test store.
  let paper = await post('/api/papers', { title: 'QA embedded close', ideaSpark: 'Closing fixture only.', materials: [], language: 'en' });
  const paperPath = '/api/papers/' + paper.id;
  paper = await post(paperPath + '/figure-candidates', { scene, caption: 'Original accepted figure', expectedRevision: 0,
    expectedSourceRevision: paper.sourceRevision, expectedDependencyVersions: { method: 0, experiments: 0 } });
  paper = await post(paperPath + '/candidates/accept', { ids: [paper.candidates.at(-1).id], batch: false });
  const originalAsset = paper.assets.at(-1), embeddedContext = await newContext(), embeddedPage = await embeddedContext.newPage();
  const getChild = async () => {
    const iframe = embeddedPage.locator('iframe[title="论文矢量画板"]');
    await expect(iframe).toBeVisible();
    return (await iframe.elementHandle()).contentFrame();
  };
  const openFigures = async () => {
    await embeddedPage.locator('[data-module="figures"]').click();
    await embeddedPage.getByRole('button', { name: '矢量画板', exact: true }).click();
    return getChild();
  };
  await embeddedPage.goto(base + '/?project=' + paper.id, { waitUntil: 'networkidle' });
  let child = await openFigures();
  await expect(child.locator('[data-layer-module]')).toHaveCount(1);
  await directlyClose(child);
  await assertEmpty(child);
  await expect(embeddedPage.getByLabel('选择画板中的图')).toHaveValue('new');
  assert.equal(await embeddedPage.evaluate(key => JSON.parse(localStorage.getItem(key)).projectClosed, 'paper-atelier-embedded-' + paper.id), true);
  await embeddedPage.reload({ waitUntil: 'networkidle' });
  child = await openFigures();
  await assertEmpty(child);
  await expect(embeddedPage.getByLabel('选择画板中的图')).toHaveValue('new');
  embeddedPage.on('dialog', dialog => dialog.accept());
  await embeddedPage.getByLabel('选择画板中的图').selectOption(originalAsset.id);
  await expect(child.locator('[data-layer-module]')).toHaveCount(1);
  await embeddedPage.getByRole('button', { name: '章节编辑', exact: true }).click();
  await embeddedPage.locator('[data-module="method"]').click();
  child = await openFigures();
  await expect(child.locator('[data-layer-module]')).toHaveCount(1);
  await directlyClose(child);
  await expect(embeddedPage.getByLabel('选择画板中的图')).toHaveValue('new');
  await importJson(child, downloaded);
  await child.getByRole('button', { name: '提交到论文', exact: true }).click();
  const submission = embeddedPage.getByRole('dialog', { name: '提交图表候选', exact: true });
  await submission.getByLabel('图表图注').fill('New independent figure after close');
  const sending = embeddedPage.waitForRequest(request => request.method() === 'POST' && request.url() === base + paperPath + '/figure-candidates');
  await submission.getByRole('button', { name: '提交候选', exact: true }).click();
  assert.ok(!(await sending).postDataJSON().previousAssetId, 'Closed board retained its old paper-asset identity');
  await expect(submission).toBeHidden();
  paper = await fetch(base + paperPath).then(response => response.json());
  const pending = paper.candidates.findLast(candidate => candidate.status === 'pending');
  assert.notEqual(pending.assets[0].figureId, originalAsset.figureId);
  paper = await post(paperPath + '/candidates/accept', { ids: [pending.id], batch: false });
  assert.equal(paper.modules.figures.assetIds.length, 2);
  assert.deepEqual(paper.assets.find(asset => asset.id === originalAsset.id), originalAsset, 'Closing deleted or changed the prior saved figure');
  await embeddedContext.close();

  assert.deepEqual(forbidden, [], 'Closing a project invoked a model');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  const report = { passed: true, modelCalls: 0, checks: ['close disabled while busy or empty', 'cancel and Escape preserve edits', 'storage failure preserves scene and history', 'JSON export captures current edits before close', 'canvas/materials/history/run state cleared, config retained', 'immediate reload respects closed sentinel', 'JSON and SVG reopen clear sentinel', 'delayed latest response cannot revive closed scene', 'embedded close survives reload', 'explicit asset reopen survives iframe remount', 'submission after close creates independent figure, preserving saved history'] };
  await writeFile(join(qa, 'close-project-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: join(qa, 'close-project-failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ errors, forbidden, recentReads, importErrors: await page.locator('.error-banner').allTextContents() }));
  throw error;
} finally {
  await browser.close();
}

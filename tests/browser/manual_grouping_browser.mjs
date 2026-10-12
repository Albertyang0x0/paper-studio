// Real box selection and manual grouping, using public UI and exported JSON.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(process.env.PAPER_TEST_NODE_MODULES
  ? join(resolve(process.env.PAPER_TEST_NODE_MODULES), '__manual_grouping__.cjs') : import.meta.url);
let chromium, expect;
try {
  ({ chromium } = require('playwright'));
  ({ expect } = require('playwright/test'));
} catch {
  throw Error('Manual grouping tests need Playwright. Set PAPER_TEST_NODE_MODULES to an existing node_modules containing playwright.');
}
const base = process.env.PAPER_TEST_BASE_URL ?? 'http://localhost:8788';
assert.ok(process.env.PAPER_TEST_ROOT, 'Run through scripts/test-ui.mjs to isolate test data');
assert.equal(new URL(base).port, '8788', 'Manual grouping only uses the isolated test port');
const status = await fetch(base + '/api/status').then(response => response.json());
assert.equal(status.dataScope, 'test', 'Refusing to use live server data');
const artifactDir = join(repo, 'test-artifacts', 'manual-grouping');
await mkdir(artifactDir, { recursive: true });
const edge = join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PAPER_TEST_BROWSER ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined) });
const context = await browser.newContext({ viewport: { width: 1700, height: 1050 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage(), errors = [], forbidden = [];
page.on('pageerror', error => errors.push(String(error)));
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (/^https?:$/.test(url.protocol) && url.origin !== new URL(base).origin) {
    forbidden.push(url.href); return route.abort();
  }
  if (url.pathname.startsWith('/api/')) {
    if (route.request().method() === 'GET') {
      if (url.pathname === '/api/status') return route.fulfill({ json: { ...status, references: [] } });
      if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
      if (url.pathname === '/api/models') return route.fulfill({ json: { models: [] } });
      if (url.pathname === '/api/settings') return route.fulfill({ json: { configured: false, connections: [], defaultConnectionId: '', defaultImageConnectionId: '' } });
    }
    forbidden.push(url.href);
    return route.fulfill({ status: 500, json: { error: 'Manual grouping must not invoke generation or change server data' } });
  }
  return route.continue();
});
function module(id, title, x, y, width, height, color, locked = false) {
  const children = [
    { id: id + '-shape', type: 'rect', x: 0, y: 0, width, height, fill: color, strokeWidth: 0 },
    { id: id + '-text', type: 'text', x: 15, y: 25, text: title, fontSize: 22, fill: '#ffffff', strokeWidth: 0 },
  ];
  return { id, title, x, y, width, height, contentWidth: width, contentHeight: height,
    role: 'structure', brief: 'Native test objects', componentIds: [], sourceRefs: [], labels: [], ports: [], method: 'vector-agent', status: 'ready', locked,
    elements: id === 'alpha' ? [
      { id: 'original-svg-group', type: 'group', x: 0, y: 0, opacity: .85, clip: [{ path: 'M0 0H170V105H0Z' }], children },
      { id: 'alpha-detail', type: 'ellipse', x: 130, y: 65, width: 35, height: 30, fill: '#ffcc55', strokeWidth: 0 },
    ] : children };
}
const fixture = {
  schema: 'paper-atelier/1', id: 'manual-grouping-fixture', figureType: 'svg-import', title: 'Manual grouping fixture', width: 1000, height: 700,
  style: { font: 'Arial', ink: '#222222', muted: '#666666', accent: '#2266aa', palette: ['#cc5533'], lineWidth: 0, bodySize: 22, titleSize: 24, illustrationStyle: 'native' },
  regions: [], connectors: [],
  modules: [module('alpha', 'Alpha', 100, 120, 180, 110, '#cc5533'), module('beta', 'Beta', 245, 165, 180, 110, '#3355bb'),
    module('gamma', 'Gamma', 500, 140, 140, 110, '#21865a'), module('locked', 'Locked module', 110, 300, 160, 80, '#997722', true)],
  annotations: [
    { id: 'caption', type: 'text', x: 90, y: 450, text: 'Separate caption', fontSize: 24, fill: '#222222', strokeWidth: 0 },
    { id: 'badge', type: 'rect', x: 320, y: 450, width: 60, height: 40, fill: '#bb4499', strokeWidth: 0 },
    { id: 'locked-label', type: 'text', x: 500, y: 285, text: 'Locked label', fontSize: 20, fill: '#222222', strokeWidth: 0, locked: true },
  ],
};
const draft = page.getByTestId('manual-group-draft');
const candidate = title => draft.locator('[data-group-member]').filter({ hasText: title });
const refKey = ref => `${ref.kind}:${ref.moduleId ?? ''}:${ref.id}`;
const groups = scene => scene.manualGroups ?? [];
async function importJson(scene = fixture) {
  await page.locator('input[type=file][accept=".json"]').setInputFiles({ name: 'grouping.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(scene)) });
  await expect(page.locator('.editor-title')).toHaveText(scene.title);
  if (!groups(scene).length) await expect(page.locator('[data-layer-module]')).toHaveCount(scene.modules.length);
}
async function exportFile(format = 'json') {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: format === 'json' ? 'JSON 可编辑项目' : 'SVG 矢量图', exact: true }).click();
  const source = await readFile(await (await downloading).path(), 'utf8');
  return format === 'json' ? JSON.parse(source) : source;
}
async function fitView() {
  await page.getByTitle('适应画板', { exact: true }).click();
  return page.locator('canvas.lower-canvas').evaluate(async (canvas, scene) => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const width = parseFloat(canvas.style.width), height = parseFloat(canvas.style.height);
    const z = Math.min((width - 68) / scene.width, (height - 68) / scene.height, 1);
    return { z, x: (width - scene.width * z) / 2, y: (height - scene.height * z) / 2 };
  }, fixture);
}
async function dragBox(view, rect = { x: 75, y: 95, width: 610, height: 305 }, start = true) {
  if (start) await page.getByRole('button', { name: '框选图层', exact: true }).click();
  const selector = page.locator('.canvas-box-selector');
  await expect(selector).toBeVisible();
  const box = await selector.boundingBox();
  await page.mouse.move(box.x + view.x + rect.x * view.z, box.y + view.y + rect.y * view.z);
  await page.mouse.down();
  await page.mouse.move(box.x + view.x + (rect.x + rect.width) * view.z, box.y + view.y + (rect.y + rect.height) * view.z, { steps: 12 });
  await page.mouse.up();
  await expect(draft).toBeVisible();
}
async function selectedGroupBounds(id) {
  await page.locator(`[data-manual-group=${JSON.stringify(id)}]`).click();
  const bounds = page.getByTestId('manual-group-bounds');
  await expect(bounds).toBeVisible();
  return bounds.boundingBox();
}
function unchangedObjects(actual, expected, message) {
  assert.deepEqual(actual.modules, expected.modules, message + ': module order or geometry changed');
  assert.deepEqual(actual.annotations, expected.annotations, message + ': annotations changed');
  assert.deepEqual(actual.connectors, expected.connectors, message + ': connectors changed');
}
async function raster(svg) {
  return page.evaluate(async svg => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 700;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png');
    } finally { URL.revokeObjectURL(url); }
  }, svg);
}
function closeEnough(a, b, label, tolerance = .01) {
  assert.ok(Math.abs(a - b) < tolerance, `${label}: expected ${b}, received ${a}`);
}

try {
  await page.goto(base + '/figure', { waitUntil: 'networkidle' });
  await importJson();
  const original = await exportFile(), originalRaster = await raster(await exportFile('svg'));
  const view = await fitView();
  await page.getByTitle('放大', { exact: true }).click(); view.z *= 1.18;
  await page.getByRole('region', { name: '画布视角', exact: true }).focus();
  await page.keyboard.press('ArrowRight'); view.x -= 40;
  await page.keyboard.press('ArrowDown'); view.y -= 40;
  await dragBox(view);
  await expect(draft).toContainText('已选 3 个对象');
  await expect(draft.locator('[data-group-member]')).toHaveCount(3);
  for (const title of ['Alpha', 'Beta', 'Gamma']) await expect(candidate(title)).toBeVisible();
  await expect(candidate('Locked')).toHaveCount(0);
  await candidate('Alpha').getByTestId('preview-group-member').click();
  await expect(page.locator('[data-group-highlight][data-preview="true"]')).toHaveCount(1);
  await candidate('Gamma').getByRole('button', { name: /^移出选区/ }).click();
  await expect(draft).toContainText('已选 2 个对象');
  await expect(draft.locator('[data-group-member]')).toHaveCount(2);
  unchangedObjects(await exportFile(), original, 'Review/removing a candidate must not delete or edit objects');
  await page.getByRole('button', { name: '组合所选图层', exact: true }).click();
  await expect(draft).toHaveCount(0);
  const grouped = await exportFile();
  assert.equal(groups(grouped).length, 1);
  const innerId = grouped.manualGroups[0].id;
  assert.deepEqual(grouped.manualGroups[0].members.map(refKey).sort(), ['module::alpha', 'module::beta']);
  unchangedObjects(grouped, original, 'Grouping must keep original objects and paint order');
  assert.equal(await raster(await exportFile('svg')), originalRaster, 'Grouping changed visible SVG pixels or paint order');
  await page.getByTitle('撤销 Ctrl+Z', { exact: true }).click();
  const creationUndone = await exportFile();
  assert.equal(groups(creationUndone).length, 0); unchangedObjects(creationUndone, original, 'Undo grouping');
  await page.getByTitle('重做 Ctrl+Shift+Z', { exact: true }).click();
  assert.deepEqual(await exportFile(), grouped, 'Redo lost manual grouping metadata');

  const reopened = { ...grouped, title: 'Reopened manual group' };
  await importJson(reopened);
  assert.deepEqual(await exportFile(), reopened, 'JSON reopen lost manual groups');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('paper-atelier-v1') ?? '{}').scene)).toEqual(reopened);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('.editor-title')).toHaveText(reopened.title);
  assert.deepEqual(await exportFile(), reopened, 'Refresh lost saved manual groups');
  const moveView = await fitView(), beforeDrag = await selectedGroupBounds(innerId);
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 + 52, beforeDrag.y + beforeDrag.height / 2 + 28, { steps: 10 });
  await page.mouse.up();
  const moved = await exportFile();
  for (const id of ['alpha', 'beta']) {
    const before = reopened.modules.find(item => item.id === id), after = moved.modules.find(item => item.id === id);
    closeEnough(after.x, before.x + 52 / moveView.z, id + ' group drag X');
    closeEnough(after.y, before.y + 28 / moveView.z, id + ' group drag Y');
    assert.deepEqual(after.elements, before.elements, 'Dragging a manual group rewrote the original SVG children');
  }
  for (const id of ['gamma', 'locked']) assert.deepEqual(moved.modules.find(item => item.id === id), original.modules.find(item => item.id === id), 'Group drag changed an excluded/locked module');
  assert.deepEqual(moved.annotations, original.annotations);

  const beforeScale = await selectedGroupBounds(innerId);
  await page.mouse.move(beforeScale.x + beforeScale.width, beforeScale.y + beforeScale.height);
  await page.mouse.down();
  await page.mouse.move(beforeScale.x + beforeScale.width * 1.2, beforeScale.y + beforeScale.height * 1.2, { steps: 12 });
  await page.mouse.up();
  const scaled = await exportFile();
  const alpha = scaled.modules.find(item => item.id === 'alpha'), beforeAlpha = moved.modules.find(item => item.id === 'alpha');
  const scale = alpha.width / beforeAlpha.width;
  assert.ok(scale > 1.1 && scale < 1.3, 'Corner control did not resize the group: ' + scale);
  for (const id of ['alpha', 'beta']) {
    const before = moved.modules.find(item => item.id === id), after = scaled.modules.find(item => item.id === id);
    closeEnough(after.width / before.width, scale, id + ' shared width scale');
    closeEnough(after.height / before.height, scale, id + ' shared height scale');
    closeEnough(after.x - alpha.x, (before.x - beforeAlpha.x) * scale, id + ' relative X scale');
    closeEnough(after.y - alpha.y, (before.y - beforeAlpha.y) * scale, id + ' relative Y scale');
    assert.deepEqual(after.elements, before.elements, 'Scaling a manual group rewrote the original SVG group');
  }
  for (const id of ['gamma', 'locked']) assert.deepEqual(scaled.modules.find(item => item.id === id), original.modules.find(item => item.id === id), 'Scale changed an excluded/locked module');
  assert.deepEqual(scaled.annotations, original.annotations);
  await page.screenshot({ path: join(artifactDir, 'grouped-and-scaled.png') });

  // Selecting an existing manual group with another object creates a parent
  // group; removing that parent must preserve the original manual group.
  const nestedView = await fitView();
  await dragBox(nestedView, { x: 75, y: 80, width: 610, height: 330 });
  await expect(draft).toContainText('已选 2 个对象');
  await page.getByRole('button', { name: '组合所选图层', exact: true }).click();
  const nested = await exportFile();
  assert.equal(groups(nested).length, 2);
  const outer = nested.manualGroups.find(group => group.id !== innerId);
  assert.deepEqual(outer.members.map(refKey).sort(), ['group::' + innerId, 'module::gamma'].sort());
  unchangedObjects(nested, scaled, 'Nesting manual groups');
  await selectedGroupBounds(outer.id);
  await page.getByRole('button', { name: '取消组合', exact: true }).click();
  const parentRemoved = await exportFile();
  assert.deepEqual(groups(parentRemoved), groups(scaled), 'Removing a parent manual group removed its original child group');
  unchangedObjects(parentRemoved, scaled, 'Removing a parent manual group');
  await selectedGroupBounds(innerId);
  await page.getByRole('button', { name: '取消组合', exact: true }).click();
  const ungrouped = await exportFile();
  assert.equal(groups(ungrouped).length, 0);
  unchangedObjects(ungrouped, scaled, 'Ungroup must preserve edited positions and source SVG groups');
  assert.equal(ungrouped.modules.find(item => item.id === 'alpha').elements[0].id, 'original-svg-group');
  await page.getByTitle('撤销 Ctrl+Z', { exact: true }).click();
  assert.deepEqual(groups(await exportFile()), groups(scaled), 'Undo ungroup did not restore logical membership');
  await page.getByTitle('重做 Ctrl+Shift+Z', { exact: true }).click();
  unchangedObjects(await exportFile(), scaled, 'Redo ungroup changed geometry');

  await importJson();
  await dragBox(await fitView(), { x: 70, y: 430, width: 340, height: 100 });
  await expect(draft).toContainText('已选 2 个对象');
  await page.getByRole('button', { name: '组合所选图层', exact: true }).click();
  const annotationGroup = await exportFile();
  assert.equal(groups(annotationGroup).length, 1);
  assert.deepEqual(annotationGroup.manualGroups[0].members.map(refKey).sort(), ['primitive::badge', 'primitive::caption']);
  unchangedObjects(annotationGroup, original, 'Grouping standalone annotations');
  assert.equal(await raster(await exportFile('svg')), originalRaster, 'Grouping annotations changed SVG pixels');
  await selectedGroupBounds(annotationGroup.manualGroups[0].id);
  await page.getByRole('button', { name: '取消组合', exact: true }).click();

  // A native SVG group with clip/opacity remains one direct member when the
  // user groups it with another primitive inside its module.
  await page.locator('[data-layer-module="alpha"]').click();
  await page.getByRole('button', { name: '进入模块，编辑内部对象', exact: true }).click();
  await dragBox(await fitView(), { x: 75, y: 95, width: 230, height: 170 });
  await expect(draft).toContainText('已选 2 个对象');
  await page.getByRole('button', { name: '组合所选图层', exact: true }).click();
  const internalGroup = await exportFile();
  assert.equal(groups(internalGroup).length, 1);
  assert.equal(internalGroup.manualGroups[0].moduleId, 'alpha');
  assert.deepEqual(internalGroup.manualGroups[0].members.map(refKey).sort(), ['primitive:alpha:alpha-detail', 'primitive:alpha:original-svg-group']);
  unchangedObjects(internalGroup, original, 'Grouping within an SVG module');
  assert.equal(await raster(await exportFile('svg')), originalRaster, 'Internal grouping changed SVG clip, opacity, or paint order');
  await selectedGroupBounds(internalGroup.manualGroups[0].id);
  await page.getByRole('button', { name: '取消组合', exact: true }).click();
  unchangedObjects(await exportFile(), original, 'Ungrouping within an SVG module');
  assert.equal(await raster(await exportFile('svg')), originalRaster, 'Internal ungroup changed SVG clip or opacity');

  // An unconfirmed selection belongs only to the currently open document.
  await importJson();
  await dragBox(await fitView());
  await expect(draft.locator('[data-group-member]')).toHaveCount(3);
  await importJson({ ...fixture, title: 'Import clears grouping draft' });
  await expect(draft).toHaveCount(0);
  await expect(page.locator('.canvas-box-selector')).toHaveCount(0);
  await dragBox(await fitView());
  await page.getByRole('button', { name: '关闭项目', exact: true }).click();
  await page.getByRole('dialog', { name: '关闭当前项目', exact: true }).getByRole('button', { name: '直接关闭', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建图表', exact: true })).toBeVisible();
  await expect(draft).toHaveCount(0);
  await expect(page.locator('.canvas-box-selector')).toHaveCount(0);

  const lockedFixture = structuredClone(fixture);
  lockedFixture.title = 'Locked member protects logical group';
  lockedFixture.modules[0].elements[0].children[0].locked = true;
  lockedFixture.manualGroups = [{ id: 'locked-logical-group', title: 'Locked logical group', members: [
    { kind: 'module', id: 'alpha' }, { kind: 'module', id: 'beta' },
  ] }];
  await importJson(lockedFixture);
  const lockedOriginal = await exportFile(), lockedView = await fitView();
  const lockedCanvas = await page.locator('canvas.upper-canvas').boundingBox();
  const betaPoint = { x: lockedCanvas.x + lockedView.x + 335 * lockedView.z, y: lockedCanvas.y + lockedView.y + 240 * lockedView.z };
  // Click a genuinely unlocked member of the locked logical group, not the
  // group's layer row, so member-picking cannot bypass the inherited lock.
  await page.mouse.move(betaPoint.x, betaPoint.y);
  await page.mouse.down();
  await page.mouse.move(betaPoint.x + 60, betaPoint.y + 35, { steps: 12 });
  await page.mouse.up();
  assert.deepEqual(await exportFile(), lockedOriginal, 'Dragging an unlocked member bypassed a locked logical group');
  await expect(page.locator('[data-manual-group="locked-logical-group"]')).toHaveClass(/selected/);

  assert.deepEqual(errors, [], 'Browser runtime errors');
  assert.deepEqual(forbidden, [], 'Grouping requested unexpected APIs or external assets');
  const report = { passed: true, checks: ['zoomed/panned box coordinates', 'locked objects excluded', 'candidate preview and removal', 'precise confirmed group membership', 'unchanged paint order and SVG pixels', 'group creation undo/redo', 'JSON reopen and refresh persistence', 'actual canvas group drag', 'actual equal-ratio corner scaling', 'nested manual groups', 'ungroup preserves geometry and original SVG hierarchy', 'ungroup undo/redo', 'standalone annotation grouping', 'module-internal grouping preserves native clip and opacity', 'import and close clear temporary selection', 'locked logical group prevents dragging its unlocked member'], memberIds: ['alpha', 'beta'], excludedId: 'gamma', scale, modelCalls: 0 };
  await writeFile(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(artifactDir, 'grouped.json'), JSON.stringify(grouped, null, 2));
  await writeFile(join(artifactDir, 'transformed-ungrouped.json'), JSON.stringify(ungrouped, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ errors, forbidden, banner: await page.locator('.error-banner').allTextContents() }));
  throw error;
} finally {
  await browser.close();
}

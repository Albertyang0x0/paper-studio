// Arrow-key viewport navigation: observe rendered pixels, never Fabric internals.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(process.env.PAPER_TEST_NODE_MODULES
  ? join(resolve(process.env.PAPER_TEST_NODE_MODULES), '__canvas_navigation__.cjs') : import.meta.url);
let chromium, expect;
try {
  ({ chromium } = require('playwright'));
  ({ expect } = require('playwright/test'));
} catch {
  throw Error('Canvas navigation tests need Playwright. Set PAPER_TEST_NODE_MODULES to an existing node_modules containing playwright.');
}
const base = process.env.PAPER_TEST_BASE_URL ?? 'http://localhost:8788';
assert.ok(process.env.PAPER_TEST_ROOT, 'Run through scripts/test-ui.mjs to isolate test data');
assert.equal(new URL(base).port, '8788', 'Navigation regressions only use the isolated test port');
const status = await fetch(base + '/api/status').then(response => response.json());
assert.equal(status.dataScope, 'test', 'Refusing to run against live server data');
const artifactDir = join(repo, 'test-artifacts', 'canvas-navigation');
await mkdir(artifactDir, { recursive: true });
const edge = join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PAPER_TEST_BROWSER ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined) });
const errors = [], forbidden = [], movements = [];
const scene = {
  schema: 'paper-atelier/1', id: 'keyboard-navigation-fixture', title: 'Canvas keyboard navigation', width: 1000, height: 650,
  style: { font: 'Arial', ink: '#222222', muted: '#666666', accent: '#2266aa', palette: ['#ff0000'], lineWidth: 0, bodySize: 28, titleSize: 28, illustrationStyle: 'native' },
  regions: [], connectors: [],
  annotations: [{ id: 'cursor-text', type: 'text', x: 160, y: 95, text: 'Cursor text ABC', fontSize: 28, rotation: 0, fill: '#222222', strokeWidth: 0 }],
  modules: [{ id: 'navigation-marker', title: 'Navigation marker', role: 'structure', brief: 'A solid marker to measure viewport motion.', x: 200, y: 150,
    width: 500, height: 300, contentWidth: 500, contentHeight: 300, componentIds: [], sourceRefs: [], labels: [], ports: [], method: 'vector-agent', status: 'ready',
    elements: [{ id: 'red-marker', type: 'rect', x: 200, y: 130, width: 80, height: 60, fill: '#ff0000', strokeWidth: 0 }] }],
};
async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
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
      return route.fulfill({ status: 500, json: { error: 'Navigation must not invoke generation or change server data' } });
    }
    return route.continue();
  });
  return context;
}
async function importJson(scope) {
  await scope.locator('input[type=file][accept=".json"]').setInputFiles({ name: 'navigation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(scene)) });
  await expect(scope.locator('.editor-title')).toHaveText(scene.title);
  await expect(scope.locator('[data-layer-module="navigation-marker"]')).toBeVisible();
  await expect.poll(async () => Boolean(await markerBounds(scope))).toBe(true);
}
async function exportJson(page, scope = page) {
  await scope.getByRole('button', { name: '导出', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await scope.getByRole('menuitem', { name: 'JSON 可编辑项目', exact: true }).click();
  return JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
}
async function markerBounds(scope) {
  return scope.locator('canvas.lower-canvas').evaluate(async canvas => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (pixels[i] > 245 && pixels[i + 1] < 10 && pixels[i + 2] < 10 && pixels[i + 3] > 245) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (maxX < 0) return null;
    const ratio = canvas.width / parseFloat(canvas.style.width);
    return { x: (minX + maxX) / (2 * ratio), y: (minY + maxY) / (2 * ratio), width: (maxX - minX + 1) / ratio, height: (maxY - minY + 1) / ratio };
  });
}
function assertShift(before, after, dx, dy, label) {
  assert.ok(before && after, label + ': marker left the visible canvas');
  for (const [key, expected] of [['x', dx], ['y', dy], ['width', 0], ['height', 0]]) {
    assert.ok(Math.abs(after[key] - before[key] - expected) < .05, label + ': ' + JSON.stringify({ before, after, expected: { dx, dy } }));
  }
}
async function pressAndMeasure(page, scope, key, dx, dy) {
  const before = await markerBounds(scope), zoom = await scope.locator('.canvas-zoom span').textContent();
  await page.keyboard.press(key);
  const after = await markerBounds(scope);
  assertShift(before, after, dx, dy, key);
  assert.equal(await scope.locator('.canvas-zoom span').textContent(), zoom, key + ' changed zoom');
  movements.push({ key, dx: after.x - before.x, dy: after.y - before.y });
}

const context = await newContext(), page = await context.newPage();
try {
  await page.goto(base + '/figure', { waitUntil: 'networkidle' });
  await importJson(page);
  const original = await exportJson(page), fitted = await markerBounds(page), fitZoom = await page.locator('.canvas-zoom span').textContent();
  const host = page.getByRole('region', { name: '画布视角', exact: true });
  await host.focus();
  await expect(host).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(host).toBeFocused();
  await page.locator('canvas.upper-canvas').click({ position: { x: 10, y: 100 } });
  await expect(host).toBeFocused();

  await page.locator('[data-layer-module="navigation-marker"]').click();
  await page.getByTitle('放大', { exact: true }).click();
  const zoomed = await markerBounds(page);
  assert.ok(zoomed.width > fitted.width, 'The fixture was not zoomed in');
  // A focused toolbar button is inside the viewport region and shares its keys.
  await expect(page.getByTitle('放大', { exact: true })).toBeFocused();
  await pressAndMeasure(page, page, 'ArrowRight', -40, 0);
  await host.focus();
  for (const [key, dx, dy] of [['ArrowDown', 0, -40], ['ArrowLeft', 40, 0], ['ArrowUp', 0, 40], ['Shift+ArrowRight', -160, 0], ['Shift+ArrowLeft', 160, 0]]) {
    await pressAndMeasure(page, page, key, dx, dy);
  }
  await expect(page.locator('[data-layer-module="navigation-marker"]')).toHaveClass(/selected/);
  assertShift(zoomed, await markerBounds(page), 0, 0, 'Opposite direction keys should restore the same view');
  for (const key of ['Control+ArrowRight', 'Meta+ArrowLeft', 'Alt+ArrowDown']) await pressAndMeasure(page, page, key, 0, 0);
  assert.deepEqual(await exportJson(page), original, 'Viewport navigation changed document JSON');

  // Property text editing keeps ordinary arrow-key caret behavior.
  await page.locator('.layer-module > button.layer-row:not([data-layer-module])').filter({ hasText: 'Cursor text ABC' }).click();
  const text = page.getByLabel('文字', { exact: true });
  await text.focus();
  await text.evaluate(input => input.setSelectionRange(5, 5));
  await pressAndMeasure(page, page, 'ArrowLeft', 0, 0);
  assert.equal(await text.evaluate(input => input.selectionStart), 4, 'Viewport navigation consumed a property text caret key');

  // Fabric's inline editor uses a hidden textarea. Reach it through a real
  // canvas double click and verify its native caret, without exposing Fabric.
  await page.getByTitle('适应画板', { exact: true }).click();
  assertShift(fitted, await markerBounds(page), 0, 0, 'Fit must restore the original centered viewport');
  assert.equal(await page.locator('.canvas-zoom span').textContent(), fitZoom);
  const marker = await markerBounds(page), z = parseFloat(fitZoom) / 100;
  const textPoint = { x: marker.x + (scene.annotations[0].x + 40 - 440) * z, y: marker.y + (scene.annotations[0].y + 14 - 310) * z };
  await page.locator('canvas.upper-canvas').dblclick({ position: textPoint });
  const inlineText = page.locator('textarea[data-fabric="textarea"]');
  await expect(inlineText).toBeAttached();
  await expect(inlineText).toBeFocused();
  await page.keyboard.press('End');
  const caret = await inlineText.evaluate(input => input.selectionStart);
  assert.ok(caret > 0, 'Inline text caret did not move to the end');
  await pressAndMeasure(page, page, 'ArrowLeft', 0, 0);
  assert.equal(await inlineText.evaluate(input => input.selectionStart), caret - 1, 'Viewport navigation consumed a Fabric text caret key');
  await page.keyboard.press('Escape');
  await expect(inlineText).toHaveCount(0);

  await page.getByRole('button', { name: '关闭项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '关闭当前项目', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).focus();
  await pressAndMeasure(page, page, 'ArrowRight', 0, 0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await exportJson(page), original, 'Caret or dialog navigation changed the original JSON');
  await page.getByTitle('放大', { exact: true }).click();
  await pressAndMeasure(page, page, 'ArrowRight', -40, 0);
  await page.screenshot({ path: join(artifactDir, 'zoomed-and-panned.png') });

  // Same-origin iframe exercises the embedded editor without creating a paper
  // or changing saved user data. The test host is fulfilled only in this context.
  const embeddedContext = await newContext(), embeddedPage = await embeddedContext.newPage();
  await embeddedContext.route(base + '/navigation-test-host', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html><body style="margin:0"><iframe title="Navigation fixture frame" src="/figure?paper=navigation-fixture" style="width:100vw;height:100vh;border:0"></iframe></body></html>' }));
  await embeddedPage.goto(base + '/navigation-test-host', { waitUntil: 'networkidle' });
  const frame = await (await embeddedPage.locator('iframe').elementHandle()).contentFrame();
  assert.ok(frame);
  await importJson(frame);
  const embeddedOriginal = await exportJson(embeddedPage, frame);
  await frame.getByTitle('放大', { exact: true }).click();
  await pressAndMeasure(embeddedPage, frame, 'ArrowRight', -40, 0);
  await frame.getByRole('region', { name: '画布视角', exact: true }).focus();
  await pressAndMeasure(embeddedPage, frame, 'Shift+ArrowUp', 0, 160);
  assert.deepEqual(await exportJson(embeddedPage, frame), embeddedOriginal, 'Embedded viewport navigation changed JSON');
  await embeddedContext.close();

  assert.deepEqual(errors, [], 'Browser runtime error');
  assert.deepEqual(forbidden, [], 'Navigation invoked a model, external resource, or unexpected API');
  const report = { passed: true, checks: ['tab and pointer canvas focus', 'four directions move view by 40 screen pixels', 'Shift moves view by 160 screen pixels', 'focused zoom-button navigation', 'unchanged selection, zoom and JSON', 'Ctrl/Meta/Alt are ignored', 'property and Fabric text carets are preserved', 'dialog keys do not pan', 'fit restores centered view', 'embedded iframe navigation'], movements, modelCalls: 0 };
  await writeFile(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ errors, forbidden, movements }));
  throw error;
} finally {
  await browser.close();
}

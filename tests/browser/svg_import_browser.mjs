// Direct SVG import and native editing. No model, server conversion, or external assets.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

const require = createRequire(process.env.PAPER_TEST_NODE_MODULES
  ? join(resolve(process.env.PAPER_TEST_NODE_MODULES), '__svg_browser_test__.cjs') : import.meta.url);
let chromium, expect;
try {
  ({ chromium } = require('playwright'));
  ({ expect } = require('playwright/test'));
} catch {
  throw Error('SVG browser tests need Playwright. Set PAPER_TEST_NODE_MODULES to an existing node_modules directory containing playwright.');
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
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [], apiCalls = [], externalCalls = [];
page.on('pageerror', error => errors.push(String(error)));
await context.route('**/*', route => {
  const url = route.request().url();
  if (/^https?:/.test(url) && new URL(url).origin !== new URL(base).origin) {
    externalCalls.push(url);
    return route.abort();
  }
  return route.continue();
});
await context.route('**/api/models**', route => route.fulfill({ json: { models: [] } }));
await context.route('**/api/projects', route => route.fulfill({ json: { projects: [] } }));

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="10 20 480 300">
  <title>Editable SVG fixture</title>
  <metadata>{"schema":"paper-atelier/1","title":"Stale title","modules":[{"elements":[{"type":"text","text":"Stale metadata"}]}]}</metadata>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#335599"/></marker>
  <linearGradient id="diagonal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eebb11"/><stop offset="1" stop-color="#116699"/></linearGradient></defs>
  <path d="M50 45 L270 45" fill="none" stroke="#335599" stroke-width="3" marker-end="url(#arrow)"/>
  <rect id="editable-card" x="18" y="28" width="20" height="20" fill="#6699cc"/>
  <ellipse cx="470" cy="170" rx="10" ry="16" fill="#c45555"/>
  <g id="illustration" transform="translate(62 64) rotate(8) scale(1.2)" fill="#6699cc">
    <rect width="125" height="78"/><circle cx="190" cy="40" r="27" fill="#c45555"/>
    <path id="editable-path" d="M10 100 L110 100 L60 142 Z" fill="#486f4a"/>
  </g>
  <path d="M365 55 H440 V130 H365 Z M385 75 H420 V110 H385 Z" fill="#9955aa" fill-rule="evenodd"/>
  <path d="M305 195 L340 155 L375 195" fill="none" stroke="#bb7733" stroke-width="12" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="4"/>
  <text x="440" y="240" text-anchor="end" font-size="18" font-family="Arial" fill="#111111"><tspan x="440" dy="0">Decision</tspan><tspan x="440" dy="22.32">Record</tspan></text>
  <text x="30" y="272" font-size="14" font-family="Arial" fill="#111111">x_1 costs $5$</text>
  <text x="240" y="298" text-anchor="middle" font-size="22" font-family="Arial" fill="#222222">Editable SVG label</text>
  <rect x="360" y="278" width="100" height="35" fill="url(#diagonal)"/>
</svg>`;
const GROUPED = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240">
  <title>Grouped SVG fixture</title><rect width="360" height="240" fill="#fff"/>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#345678"/></marker></defs>
  <g data-connector-id="link" data-from="left-module" data-to="right-module"><path d="M150 85C165 85 180 125 195 125" fill="none" stroke="#345678" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)"/></g>
  <g data-module-id="left-module" transform="translate(25 35)"><rect width="125" height="100" fill="#cc6677"/><text x="8" y="50" font-family="Arial" font-size="18">Current left</text></g>
  <g data-module-id="right-module" transform="translate(195 75)"><rect width="130" height="105" fill="#44aa99"/><text x="8" y="50" font-family="Arial" font-size="18">Current right</text></g>
  <text x="180" y="222" text-anchor="middle" font-family="Arial" font-size="18">Global caption</text>
</svg>`;

function primitives(scene) {
  const descend = items => items.flatMap(item => [item, ...descend(item.children ?? [])]);
  return descend([...(scene.annotations ?? []), ...scene.modules.flatMap(module => module.elements)]);
}
async function importFile(name, source, title) {
  const json = name.endsWith('.json');
  await page.locator(json ? 'input[type=file][accept=".json"]' : 'input[aria-label="直接解析 SVG 项目"]').setInputFiles({
    name, mimeType: json ? 'application/json' : 'image/svg+xml', buffer: Buffer.from(source),
  });
  if (title) {
    await expect(page.locator('.editor-title')).toHaveText(title);
    await expect(page.locator('.error-banner')).toHaveCount(0);
    if (!json) await expect(page.getByRole('status', { name: 'SVG 导入结果', exact: true })).toBeVisible();
  }
}
async function exportFile(kind = 'json') {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: kind === 'json' ? 'JSON 可编辑项目' : 'SVG 矢量图', exact: true }).click();
  const download = await downloading;
  assert.ok(download.suggestedFilename().endsWith('.' + kind));
  const source = await readFile(await download.path(), 'utf8');
  return kind === 'json' ? JSON.parse(source) : source;
}
async function selectLayer(label) {
  const globals = page.locator('.layer-module > button.layer-row:not([data-layer-module]):not([data-layer-connector])').filter({ hasText: label });
  if (await globals.count()) return globals.first().click();
  for (const owner of await page.locator('[data-layer-module]').all()) {
    await owner.click();
    const children = page.locator('.layer-elements button').filter({ hasText: label });
    if (await children.count()) return children.first().click();
  }
  assert.fail('Missing editable native layer: ' + label);
}
async function fidelity(source, output, width, height) {
  return page.evaluate(async ({ source, output, width, height }) => {
    async function raster(svg) {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height); return ctx.getImageData(0, 0, width, height).data;
      } finally { URL.revokeObjectURL(url); }
    }
    const [a, b] = await Promise.all([raster(source), raster(output)]);
    let total = 0, changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      let delta = 0;
      for (let c = 0; c < 3; c++) delta += Math.abs(a[i + c] - b[i + c]);
      total += delta; if (delta > 60) changed++;
    }
    return { meanChannelError: total / (width * height * 3), changedPixelFraction: changed / (width * height) };
  }, { source, output, width, height });
}
async function connectorPoints(svg) {
  return page.evaluate(svg => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const path = doc.querySelector('[data-connector-id="link"] path');
    const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
    return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
  }, svg);
}

try {
  await page.goto(base + '/figure', { waitUntil: 'networkidle' });
  // Initial settings reads are allowed. All import/edit/export activity below
  // must now work without even a local API request, regardless of endpoint.
  await context.route('**/api/**', route => {
    apiCalls.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: 'SVG editing must stay local' } });
  });
  await importFile('editable.svg', SVG, 'Editable SVG fixture');
  const original = await exportFile(), items = primitives(original);
  assert.equal(original.schema, 'paper-atelier/1');
  assert.deepEqual([original.width, original.height], [480, 300]);
  for (const type of ['rect', 'ellipse', 'path', 'text']) assert.ok(items.some(item => item.type === type), type);
  assert.ok(items.every(item => !['image', 'svg'].includes(item.type) && !item.dataUrl));
  assert.ok(!items.some(item => item.text === 'Stale metadata'));
  const textLines = items.flatMap(item => (item.text ?? '').split('\n'));
  for (const text of ['Editable SVG label', 'Decision', 'Record', 'x_1 costs $5$']) assert.ok(textLines.includes(text), text);
  const originalExport = await exportFile('svg');
  assert.ok(await page.evaluate(svg => Array.from(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text'))
    .some(node => node.textContent === 'x_1 costs $5$'), originalExport), 'SVG export rewrote literal source text as math');
  const geometry = await fidelity(SVG, originalExport, 480, 300);
  assert.ok(geometry.meanChannelError < 1.5 && geometry.changedPixelFraction < .025, JSON.stringify(geometry));
  const screenshot = process.env.PAPER_TEST_SCREENSHOT ?? join(qa, 'svg-import-native.png');
  await mkdir(dirname(resolve(screenshot)), { recursive: true });
  await page.screenshot({ path: screenshot });

  await selectLayer('Editable SVG label');
  const text = page.getByLabel('文字', { exact: true });
  await text.fill('Human edited SVG label');
  await page.getByTitle('撤销 Ctrl+Z', { exact: true }).click();
  await expect(text).toHaveValue('Editable SVG label');
  await page.getByTitle('重做 Ctrl+Shift+Z', { exact: true }).click();
  await expect(text).toHaveValue('Human edited SVG label');
  const rect = items.find(item => item.type === 'rect' && item.id.includes('editable-card'));
  assert.ok(rect);
  await selectLayer(rect.id);
  await page.getByLabel('填充颜色', { exact: true }).fill('#4488aa');
  await page.getByLabel('X', { exact: true }).fill(String(rect.x + 13));
  const edited = await exportFile(), changed = primitives(edited).find(item => item.id === rect.id);
  assert.equal(changed.fill, '#4488aa'); assert.equal(changed.x, rect.x + 13);
  assert.ok(primitives(edited).some(item => item.text === 'Human edited SVG label'));
  edited.title = 'Reopened editable JSON';
  await importFile('edited.json', JSON.stringify(edited), edited.title);
  assert.deepEqual(await exportFile(), edited, 'JSON reopen lost native edits');
  await writeFile(join(qa, 'svg-import-edited.json'), JSON.stringify(edited, null, 2));

  const externallyEdited = (await exportFile('svg')).replace('>Human edited SVG label<', '>External SVG edit<');
  await importFile('external.svg', externallyEdited.replace('<title>' + edited.title, '<title>External edit'), 'External edit');
  assert.ok(primitives(await exportFile()).some(item => item.text === 'External SVG edit'), 'Stale embedded JSON replaced visible text');

  const scaledSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><title>Unequal SVG scale</title><g transform="translate(10 10)"><path d="M10 10 C40 90 70 10 90 90" transform="scale(2 1)" fill="none" stroke="#123456" stroke-width="8"/></g></svg>';
  await importFile('scaled-stroke.svg', scaledSvg, 'Unequal SVG scale');
  const scaledGeometry = await fidelity(scaledSvg, await exportFile('svg'), 240, 120);
  assert.ok(scaledGeometry.meanChannelError < .2, JSON.stringify(scaledGeometry));

  await importFile('grouped.svg', GROUPED, 'Grouped SVG fixture');
  await expect(page.locator('[data-layer-module]')).toHaveCount(2);
  const grouped = await exportFile();
  assert.deepEqual(grouped.modules.map(module => module.id), ['left-module', 'right-module']);
  assert.ok(grouped.annotations.some(item => item.text === 'Global caption'));
  assert.equal(grouped.connectors.length, 1);
  assert.deepEqual([grouped.connectors[0].from, grouped.connectors[0].to], ['left-module', 'right-module']);
  const beforeSvg = await exportFile('svg'), groupedGeometry = await fidelity(GROUPED, beforeSvg, 360, 240);
  assert.ok(groupedGeometry.meanChannelError < .2, JSON.stringify(groupedGeometry));
  await page.locator('[data-layer-module="left-module"]').click();
  await page.getByLabel('X', { exact: true }).fill(String(grouped.modules[0].x + 31));
  const moved = await exportFile();
  assert.deepEqual(moved.modules[1], grouped.modules[1], 'Moving one SVG group changed its sibling');
  assert.deepEqual(moved.annotations, grouped.annotations);
  assert.deepEqual(moved.connectors, grouped.connectors);
  const before = await connectorPoints(beforeSvg), after = await connectorPoints(await exportFile('svg'));
  assert.ok(Math.abs(after.start.x - before.start.x - 31) < .001, 'Arrow did not follow the moved module');
  assert.deepEqual(after.end, before.end);
  await page.screenshot({ path: join(qa, 'svg-import-group-moved.png') });

  let sampleResult;
  if (process.env.PAPER_TEST_SVG_SAMPLE) {
    const source = await readFile(process.env.PAPER_TEST_SVG_SAMPLE, 'utf8');
    const details = await page.evaluate(source => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      return { title: doc.querySelector('title')?.textContent, labels: Array.from(doc.querySelectorAll('text')).map(node => node.textContent) };
    }, source);
    assert.ok(details.title, 'Optional sample needs an SVG title to synchronize import');
    await importFile(basename(process.env.PAPER_TEST_SVG_SAMPLE), source, details.title);
    // DOM textContent concatenates adjacent tspan lines without a separator;
    // native text may represent the same visible lines with a newline.
    const sample = await exportFile(), importedText = primitives(sample).map(item => item.text ?? '').join('').replace(/\s+/g, '');
    for (const label of details.labels) assert.ok(importedText.includes(label.replace(/\s+/g, '')), 'Sample lost visible text: ' + label);
    const geometry = await fidelity(source, await exportFile('svg'), sample.width, sample.height);
    assert.ok(geometry.meanChannelError < 1.5, JSON.stringify(geometry));
    sampleResult = { name: basename(process.env.PAPER_TEST_SVG_SAMPLE), modules: sample.modules.length, textNodes: details.labels.length, geometry };
  }

  const beforeRejection = await exportFile();
  const wrap = (body, attributes = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" ${attributes}>${body}</svg>`;
  const rejected = {
    'malformed.svg': '<svg><rect></svg>',
    'bad-path.svg': wrap('<path d="M10 10 L20"/>'),
    'external-image.svg': wrap('<image href="https://svg-import.invalid/tracker.png" width="100" height="100"/>'),
    'broken-embedded-image.svg': wrap('<image href="data:image/png;base64,iVBORw0KGgo=" width="100" height="100"/>'),
    'filter.svg': wrap('<defs><filter id="blur"><feGaussianBlur stdDeviation="5"/></filter></defs><rect width="100" height="100" filter="url(#blur)"/>'),
    'missing-clip.svg': wrap('<rect width="100" height="100" clip-path="url(#missing)"/>'),
    'recursive-use.svg': wrap('<defs><g id="loop"><use href="#loop"/></g></defs><use href="#loop"/>'),
    'script.svg': wrap('<script>window.svgImportExecuted=true</script><rect width="100" height="100"/>'),
    'event.svg': wrap('<rect width="100" height="100"/>', 'onload="window.svgImportExecuted=true"'),
    'skewed-stroke.svg': wrap('<path d="M5 5 L30 30" transform="skewX(15)" fill="none" stroke="#123456" stroke-width="8"/>'),
    'hidden-root.svg': wrap('<rect width="100" height="100"/>', 'display="none"'),
    'unsupported-attribute.svg': wrap('<rect width="100" height="100" vector-effect="non-scaling-stroke"/>'),
  };
  for (const [name, source] of Object.entries(rejected)) {
    await importFile(name, source);
    await expect(page.locator('.error-banner')).toBeVisible();
    assert.deepEqual(await exportFile(), beforeRejection, name + ' replaced the current scene');
    await page.locator('.error-banner button').last().click();
    await expect(page.locator('.error-banner')).toHaveCount(0);
  }
  assert.equal(await page.evaluate(() => Boolean(window.svgImportExecuted)), false);
  assert.deepEqual(apiCalls, [], 'SVG import/edit/export sent an API request');
  assert.deepEqual(externalCalls, [], 'SVG import fetched an external resource');
  assert.deepEqual(errors, [], 'Browser runtime error');
  const report = { passed: true, checks: ['direct native SVG import', 'viewBox/transforms/paths/markers/gradients', 'text/color/position editing', 'undo/redo', 'JSON roundtrip', 'visible SVG beats metadata', 'nonuniform stroke scaling', 'independent groups and attached arrows', 'unsupported input preserves current scene'], geometry, scaledGeometry, groupedGeometry, sampleResult, rejectedInputs: Object.keys(rejected), apiCalls: 0, modelCalls: 0 };
  await writeFile(join(qa, 'svg-import-browser.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: join(qa, 'svg-import-failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ errors, apiCalls, externalCalls, importErrors: await page.locator('.error-banner').allTextContents() }));
  throw error;
} finally {
  await browser.close();
}

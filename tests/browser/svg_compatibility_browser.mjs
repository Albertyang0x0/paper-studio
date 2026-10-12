// Real SVG compatibility, visual fidelity, editing, and image lifecycle regressions.
// All samples are read unchanged; every browser context and server is isolated.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(process.env.PAPER_TEST_NODE_MODULES
  ? join(resolve(process.env.PAPER_TEST_NODE_MODULES), '__svg_compat_test__.cjs') : import.meta.url);
let chromium, expect;
try {
  ({ chromium } = require('playwright'));
  ({ expect } = require('playwright/test'));
} catch {
  throw Error('SVG compatibility tests need Playwright. Set PAPER_TEST_NODE_MODULES to an existing node_modules directory containing playwright.');
}
const base = process.env.PAPER_TEST_BASE_URL ?? 'http://localhost:8788';
assert.ok(process.env.PAPER_TEST_ROOT, 'Run through scripts/test-ui.mjs to isolate server data');
assert.equal(new URL(base).port, '8788', 'Compatibility regressions only use the isolated 8788 server');
const status = await fetch(base + '/api/status').then(response => response.json());
assert.equal(status.dataScope, 'test', 'Refusing to use live server data');
const externalCorpus = Boolean(process.env.PAPER_TEST_SVG_CORPUS_DIR);
const sampleDir = process.env.PAPER_TEST_SVG_CORPUS_DIR ?? process.env.PAPER_TEST_SVG_COMPAT_DIR ?? join(repo, 'SVG_TO_JSON_TEST');
const artifactDir = process.env.PAPER_TEST_SVG_COMPAT_OUTPUT ?? join(repo, 'test-artifacts', 'svg-compatibility');
await mkdir(artifactDir, { recursive: true });
// The curated diagram set can change independently of the old numbered corpus.
// Keep known unsupported examples in the report rather than silently skipping them.
const corpusFiles = (await readdir(sampleDir)).filter(file => /\.svg$/i.test(file)).sort();
assert.ok(corpusFiles.length, 'The selected SVG corpus contains no SVG files');
const selectors = (process.env.PAPER_TEST_SVG_COMPAT_FILES ?? '').split(/[\s,]+/).filter(Boolean);
const matches = (file, selector) => file === selector || basename(file, '.svg') === selector || /^\d{1,2}$/.test(selector) && file.startsWith(selector.padStart(2, '0') + '_');
for (const selector of selectors) assert.ok(corpusFiles.some(file => matches(file, selector)), 'Unknown SVG compatibility sample: ' + selector);
const files = selectors.length ? corpusFiles.filter(file => selectors.some(selector => matches(file, selector))) : corpusFiles;
const editSelectors = (process.env.PAPER_TEST_SVG_EDIT_FILES ?? '').split(/[\s,]+/).filter(Boolean);
for (const selector of editSelectors) assert.ok(files.some(file => matches(file, selector)), 'Unknown or excluded SVG editing sample: ' + selector);
const editFiles = files.filter(file => /^(04|07)_/.test(file) || editSelectors.some(selector => matches(file, selector)));
const runSynthetic = !externalCorpus && !selectors.length || process.env.PAPER_TEST_SVG_COMPAT_SYNTHETIC === '1';
const edge = join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PAPER_TEST_BROWSER ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined) });
const errors = [], apiCalls = [], externalCalls = [], results = [];
const sourcePayloads = new Set(), importedPayloads = new Set();
const baselinePayloads = new Set();
let baselineImageNodes = 0;
let sourceImageNodes = 0, activePage, effectsResult, symbolResult, lifecycleResult;
const sha = data => createHash('sha256').update(data).digest('hex');
const assetKey = dataUrl => {
  const match = dataUrl.match(/^data:image\/(?:png|jpe?g);base64,([\s\S]+)$/i);
  assert.ok(match, 'Only embedded PNG/JPEG data is expected in the sample assets');
  return sha(Buffer.from(match[1].replace(/\s/g, ''), 'base64'));
};
function primitives(scene) {
  const flatten = list => list.flatMap(item => [item, ...flatten(item.children ?? [])]);
  return flatten([...(scene.annotations ?? []), ...scene.modules.flatMap(module => module.elements)]);
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1050 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  let initialized = false;
  page.on('pageerror', error => errors.push(String(error)));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (/^https?:$/.test(url.protocol) && url.origin !== new URL(base).origin) {
      externalCalls.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      if (initialized) {
        apiCalls.push(url.href);
        return route.fulfill({ status: 500, json: { error: 'SVG compatibility must stay entirely local' } });
      }
      if (url.pathname === '/api/status') return route.fulfill({ json: { ...status, references: [] } });
      if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
      if (url.pathname === '/api/settings') return route.fulfill({ json: { configured: false, connections: [], defaultConnectionId: '', defaultImageConnectionId: '' } });
      if (url.pathname === '/api/models') return route.fulfill({ json: { models: [] } });
      apiCalls.push(url.href);
      return route.fulfill({ status: 500, json: { error: 'Unexpected API in compatibility setup' } });
    }
    return route.continue();
  });
  await page.goto(base + '/figure', { waitUntil: 'networkidle' });
  initialized = true;
  activePage = page;
  return { page, context };
}
async function importSvg(page, filename, source) {
  await page.getByLabel('直接解析 SVG 项目', { exact: true }).setInputFiles({ name: filename, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await page.waitForFunction(() => Boolean(document.querySelector('.error-banner') || document.querySelector('[aria-label="SVG 导入结果"]')), null, { timeout: 30000 });
  const failures = await page.locator('.error-banner').allTextContents();
  assert.deepEqual(failures, [], filename + ': ' + failures.join('\n'));
  await expect(page.getByRole('button', { name: '导出', exact: true })).toBeEnabled();
  return page.getByRole('status', { name: 'SVG 导入结果', exact: true }).innerText();
}
async function exportFile(page, format = 'json') {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: format === 'json' ? 'JSON 可编辑项目' : 'SVG 矢量图', exact: true }).click();
  const download = await downloading;
  assert.ok(download.suggestedFilename().endsWith('.' + format));
  const source = await readFile(await download.path(), 'utf8');
  return format === 'json' ? JSON.parse(source) : source;
}
async function reopenJson(page, scene, suffix) {
  const reopened = { ...scene, title: scene.title + suffix };
  await page.locator('input[type=file][accept=".json"]').setInputFiles({ name: 'native-roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reopened)) });
  await expect(page.locator('.editor-title')).toHaveText(reopened.title);
  assert.deepEqual(await exportFile(page), reopened, 'JSON reopening changed native objects, assets, or effects');
  return reopened;
}
async function compareRasters(page, source, converted, width, height, stem, roi, excluded = []) {
  const result = await page.evaluate(async ({ source, converted, width, height, roi, excluded }) => {
    width = Math.ceil(width); height = Math.ceil(height);
    async function raster(value) {
      const url = value.startsWith('data:image/') ? value : URL.createObjectURL(new Blob([value], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        return { canvas, pixels: ctx.getImageData(0, 0, width, height).data };
      } finally { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
    }
    const [a, b] = await Promise.all([raster(source), raster(converted)]);
    const diff = document.createElement('canvas'); diff.width = width; diff.height = height;
    const ctx = diff.getContext('2d'), pixels = ctx.createImageData(width, height);
    let total = 0, changed = 0, count = 0, blurredTotal = 0, blurredChanged = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let delta = 0;
      for (let c = 0; c < 3; c++) {
        const channel = Math.abs(a.pixels[i + c] - b.pixels[i + c]);
        delta += channel; pixels.data[i + c] = Math.min(255, channel * 3);
      }
      pixels.data[i + 3] = 255;
      if ((!roi || x >= roi.x && y >= roi.y && x < roi.x + roi.width && y < roi.y + roi.height) &&
          !excluded.some(box => x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height)) {
        total += delta; count++; if (delta > 60) changed++;
        // Canvas and SVG use different edge rasterization/caches. A shared
        // one-pixel low pass measures content while the raw metrics/diff stay
        // available to reveal edge differences. It never aligns/moves objects.
        let blurredDelta = 0;
        for (let c = 0; c < 3; c++) {
          let sum = 0, neighbors = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const index = (yy * width + xx) * 4 + c;
            sum += a.pixels[index] - b.pixels[index]; neighbors++;
          }
          blurredDelta += Math.abs(sum / neighbors);
        }
        blurredTotal += blurredDelta; if (blurredDelta > 60) blurredChanged++;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    return { meanChannelError: total / (count * 3), changedPixelFraction: changed / count, comparedPixels: count,
      meanBlurredChannelError: blurredTotal / (count * 3), blurredChangedPixelFraction: blurredChanged / count,
      sourcePng: a.canvas.toDataURL('image/png'), convertedPng: b.canvas.toDataURL('image/png'), diffPng: diff.toDataURL('image/png') };
  }, { source, converted, width, height, roi, excluded });
  for (const [field, label] of [['sourcePng', 'source'], ['convertedPng', 'converted'], ['diffPng', 'diff']]) {
    await writeFile(join(artifactDir, stem + '-' + label + '.png'), Buffer.from(result[field].split(',')[1], 'base64'));
    delete result[field];
  }
  return result;
}
function assertFidelity(result, context, maxError = 2, maxChanged = .02) {
  assert.ok(result.meanChannelError < maxError && result.changedPixelFraction < maxChanged, context + ': ' + JSON.stringify(result));
}
function canvasIsFaithful(result) {
  // Less than 1.2% of the 8-bit channel range, with under 3% materially
  // different pixels, accommodates Canvas/SVG subpixel edge rasterization.
  return result.meanBlurredChannelError < 3 && result.blurredChangedPixelFraction < .03;
}
function assertCanvasFidelity(result, context) {
  assert.ok(canvasIsFaithful(result), context + ': ' + JSON.stringify(result));
}
async function canvasRaster(page, scene) {
  return page.locator('canvas.lower-canvas').evaluate(async (canvas, scene) => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const z = Math.min((canvas.clientWidth - 68) / scene.width, (canvas.clientHeight - 68) / scene.height, 1);
    const dpr = canvas.width / canvas.clientWidth;
    const tx = (canvas.clientWidth - scene.width * z) / 2, ty = (canvas.clientHeight - scene.height * z) / 2;
    const output = document.createElement('canvas'); output.width = Math.ceil(scene.width); output.height = Math.ceil(scene.height);
    output.getContext('2d').drawImage(canvas, tx * dpr, ty * dpr, scene.width * z * dpr, scene.height * z * dpr, 0, 0, output.width, output.height);
    return output.toDataURL('image/png');
  }, { width: scene.width, height: scene.height });
}
async function compareDisplayedCanvas(page, source, scene, stem, excluded = []) {
  // Match the editor's actual physical pixel grid. Upsampling a fitted document
  // back to its source size would measure resampling instead of missing content.
  // No object is selected yet, and the document's 1px frame is excluded.
  await page.getByRole('button', { name: '适应画板', exact: true }).click();
  let result;
  const capture = async () => {
    const raster = await page.locator('canvas.lower-canvas').evaluate(async (canvas, { source, scene, excluded }) => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Fabric keeps fractional CSS dimensions from ResizeObserver, whereas
      // clientHeight rounds them. Use its exact logical viewport for alignment.
      const logicalWidth = parseFloat(canvas.style.width), logicalHeight = parseFloat(canvas.style.height);
      const zoom = Math.min((logicalWidth - 68) / scene.width, (logicalHeight - 68) / scene.height, 1);
      const dpr = window.devicePixelRatio;
      const width = scene.width * zoom * dpr, height = scene.height * zoom * dpr;
      const left = (logicalWidth * dpr - width) / 2, top = (logicalHeight * dpr - height) / 2;
      const x = Math.floor(left), y = Math.floor(top), pixelWidth = Math.ceil(left + width) - x, pixelHeight = Math.ceil(top + height) - y;
      const actual = document.createElement('canvas'), expected = document.createElement('canvas');
      for (const target of [actual, expected]) { target.width = pixelWidth; target.height = pixelHeight; }
      actual.getContext('2d').drawImage(canvas, x, y, pixelWidth, pixelHeight, 0, 0, pixelWidth, pixelHeight);
      const ctx = expected.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pixelWidth, pixelHeight);
      // Rasterize the source on this grid directly, without resampling an SVG
      // image at its rounded intrinsic pixel size (notably sample 01's 95.95px).
      const referenceDoc = new DOMParser().parseFromString(source.replace(/<!DOCTYPE[^>]*>/gi, ''), 'image/svg+xml');
      referenceDoc.documentElement.setAttribute('width', String(scene.width));
      referenceDoc.documentElement.setAttribute('height', String(scene.height));
      const referenceSource = new XMLSerializer().serializeToString(referenceDoc.documentElement);
      const reference = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}"><g transform="translate(${left-x} ${top-y}) scale(${zoom*dpr})">${referenceSource}</g></svg>`;
      const url = URL.createObjectURL(new Blob([reference], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        ctx.drawImage(image, 0, 0);
      } finally { URL.revokeObjectURL(url); }
      return { source: expected.toDataURL('image/png'), converted: actual.toDataURL('image/png'), width: pixelWidth, height: pixelHeight,
        zoom, devicePixelRatio: dpr, roi: { x: 2, y: 2, width: pixelWidth - 4, height: pixelHeight - 4 },
        excluded: excluded.map(box => ({ x: box.x * zoom * dpr + left - x, y: box.y * zoom * dpr + top - y,
          width: box.width * zoom * dpr, height: box.height * zoom * dpr })) };
    }, { source, scene: { width: scene.width, height: scene.height }, excluded });
    result = { ...await compareRasters(page, raster.source, raster.converted, raster.width, raster.height, stem + '-canvas', raster.roi, raster.excluded),
      zoom: raster.zoom, devicePixelRatio: raster.devicePixelRatio, width: raster.width, height: raster.height };
    return canvasIsFaithful(result);
  };
  // Images/shadows render asynchronously after import. Retain final diagnostics
  // even if fidelity fails, so every sample still reaches JSON and edit checks.
  await expect.poll(capture, { timeout: 10000, intervals: [200, 500, 1000] }).toBe(true).catch(() => {});
  return result;
}
async function selectPrimitive(page, scene, primitive) {
  const descend = items => items.some(item => item.id === primitive.id || descend(item.children ?? []));
  const owner = scene.modules.find(module => descend(module.elements));
  if (owner) await page.locator('[data-layer-module]').nth(scene.modules.indexOf(owner)).click();
  const label = primitive.type === 'text' ? primitive.text.replace(/\s+/g, ' ').trim() : primitive.id;
  const choices = owner ? page.locator('.layer-elements button') : page.locator('.layer-module > button.layer-row:not([data-layer-module]):not([data-layer-connector])');
  await choices.filter({ hasText: label }).first().click();
}
async function exerciseEdits(page, scene, stem) {
  const list = primitives(scene), image = list.find(item => item.type === 'image');
  const shapes = list.filter(item => !['text', 'group', 'image'].includes(item.type));
  const filledShape = shapes.find(item => /^#[\da-f]{6}$/i.test(item.fill ?? ''));
  const shape = filledShape ?? shapes.find(item => /^#[\da-f]{6}$/i.test(item.stroke ?? ''));
  const recoloredProperty = filledShape ? 'fill' : 'stroke';
  const text = list.find(item => item.type === 'text' && item.text?.trim());
  assert.ok(shape && text, 'Editing fixture requires native shapes and text');
  const movable = image ?? shape;
  await selectPrimitive(page, scene, movable);
  await page.getByLabel('X', { exact: true }).fill(String(movable.x + 7));
  await selectPrimitive(page, scene, shape);
  await page.getByLabel(recoloredProperty === 'fill' ? '填充颜色' : '描边颜色', { exact: true }).fill('#137e69');
  await selectPrimitive(page, scene, text);
  await page.getByLabel('文字', { exact: true }).fill('Edited native SVG label');
  const edited = await exportFile(page), changed = primitives(edited);
  assert.equal(changed.find(item => item.id === movable.id).x, movable.x + 7);
  assert.equal(changed.find(item => item.id === shape.id)[recoloredProperty], '#137e69');
  assert.equal(changed.find(item => item.id === text.id).text, 'Edited native SVG label');
  assert.deepEqual(edited.assets, scene.assets, 'Editing duplicated or lost the original image assets');
  const effects = item => ({ clip: item.clip, opacity: item.opacity, svgShadow: item.svgShadow });
  for (const item of list) assert.deepEqual(effects(changed.find(candidate => candidate.id === item.id)), effects(item), 'Editing changed clipping/compositing effects');
  await reopenJson(page, edited, ' · edited reopen');
  await writeFile(join(artifactDir, stem + '-edited.json'), JSON.stringify(edited, null, 2));
  return { moved: movable.type, recolored: shape.type, recoloredProperty, textEdited: true };
}
async function saveReport() {
  await writeFile(join(artifactDir, 'report.json'), JSON.stringify({ results, sampleDir, externalCorpus, selectedFiles: files, editFiles, filtered: Boolean(selectors.length), syntheticEnabled: runSynthetic,
    sourceImageNodes, baselineImageNodes, baselineUniquePayloads: baselinePayloads.size, uniqueSourcePayloads: sourcePayloads.size,
    uniqueImportedPayloads: importedPayloads.size, effectsResult, symbolResult, lifecycleResult, errors, apiCalls, externalCalls }, null, 2));
}

try {
  for (const file of files) {
    const originalBytes = await readFile(join(sampleDir, file)), source = originalBytes.toString('utf8'), stem = basename(file, '.svg');
    const { page, context } = await newPage();
    const result = { file, sourceSha256: sha(originalBytes) };
    try {
      const sourceStats = await page.evaluate(source => {
        const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
        const images = Array.from(doc.querySelectorAll('image'));
        const href = image => image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        const missingImageRegions = images.filter(image => {
          const value = href(image) ?? '';
          return value && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]|#)/i.test(value);
        }).map(image => {
          // Detached SVG transform lists compute these matrices without mounting
          // the original document or requesting any of its image references.
          const chain = []; for (let node = image; node; node = node.parentElement) chain.unshift(node);
          let matrix = new DOMMatrix();
          for (const node of chain) {
            const value = node.getAttribute('transform'); if (!value) continue;
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.setAttribute('transform', value);
            const m = group.transform.baseVal.consolidate()?.matrix;
            if (m) matrix = matrix.multiply(new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]));
          }
          const x = Number(image.getAttribute('x') ?? 0), y = Number(image.getAttribute('y') ?? 0);
          const width = Number(image.getAttribute('width')), height = Number(image.getAttribute('height'));
          const corners = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]].map(([px, py]) => new DOMPoint(px, py).matrixTransform(matrix));
          return { x: Math.min(...corners.map(p => p.x)), y: Math.min(...corners.map(p => p.y)),
            width: Math.max(...corners.map(p => p.x)) - Math.min(...corners.map(p => p.x)),
            height: Math.max(...corners.map(p => p.y)) - Math.min(...corners.map(p => p.y)), href: href(image) };
        });
        const viewBox = doc.documentElement.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
        return { imageUrls: images.map(href), missingImageRegions, viewBox,
          preserveAspectRatio: doc.documentElement.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet', textNodes: doc.querySelectorAll('text').length };
      }, source);
      sourceImageNodes += sourceStats.imageUrls.length;
      const embeddedUrls = sourceStats.imageUrls.filter(url => /^data:image\//i.test(url ?? ''));
      result.sourceImages = { nodes: sourceStats.imageUrls.length, embedded: embeddedUrls.length,
        externalReferences: sourceStats.imageUrls.filter(url => !/^data:image\//i.test(url ?? '')) };
      const expectedAssets = new Set(embeddedUrls.map(assetKey));
      for (const key of expectedAssets) sourcePayloads.add(key);
      if (/^(0[1-9]|10)_/.test(file)) {
        baselineImageNodes += sourceStats.imageUrls.length;
        for (const key of expectedAssets) baselinePayloads.add(key);
      }
      result.warnings = await importSvg(page, file, source);
      const scene = await exportFile(page), list = primitives(scene), assets = Object.values(scene.assets ?? {});
      assert.equal(scene.schema, 'paper-atelier/1');
      assert.ok(list.length, 'Import returned no native objects');
      assert.ok(list.some(item => item.type !== 'image'), 'The diagram was flattened into one bitmap');
      const keys = assets.map(asset => assetKey(asset.dataUrl));
      assert.equal(new Set(keys).size, keys.length, 'Repeated image payloads were not deduplicated');
      assert.deepEqual(new Set(keys), expectedAssets, 'Import omitted or changed an embedded image payload');
      for (const asset of assets) assert.ok(asset.width > 0 && asset.height > 0 && ['image/png', 'image/jpeg'].includes(asset.mimeType));
      for (const key of keys) importedPayloads.add(key);
      for (const item of list.filter(item => item.type === 'image')) assert.ok(scene.assets?.[item.assetId], 'Image references a missing asset');
      const converted = await exportFile(page, 'svg');
      await writeFile(join(artifactDir, stem + '-converted.svg'), converted);
      await writeFile(join(artifactDir, stem + '-native.json'), JSON.stringify(scene, null, 2));
      result.objects = { modules: scene.modules.length, primitives: list.length, text: list.filter(item => item.type === 'text').length,
        imageInstances: list.filter(item => item.type === 'image').length, imageAssets: assets.length, clipped: list.filter(item => item.clip?.length).length, shadows: list.filter(item => item.svgShadow).length };
      const missingRegions = sourceStats.missingImageRegions.map(box => {
        const vb = sourceStats.viewBox;
        if (!vb || vb.length !== 4) return box;
        const sx = scene.width / vb[2], sy = scene.height / vb[3], preserve = sourceStats.preserveAspectRatio;
        const scaleX = preserve.includes('none') ? sx : preserve.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
        const scaleY = preserve.includes('none') ? sy : scaleX;
        const extraX = scene.width - vb[2] * scaleX, extraY = scene.height - vb[3] * scaleY;
        const offsetX = preserve.includes('xMax') ? extraX : preserve.includes('xMid') ? extraX / 2 : 0;
        const offsetY = preserve.includes('YMax') ? extraY : preserve.includes('YMid') ? extraY / 2 : 0;
        return { ...box, x: (box.x - vb[0]) * scaleX + offsetX, y: (box.y - vb[1]) * scaleY + offsetY,
          width: box.width * scaleX, height: box.height * scaleY };
      });
      if (missingRegions.length) {
        if (!externalCorpus && file.startsWith('14_')) {
          assert.equal(missingRegions.length, 2, 'Original sample 14 missing-image count changed');
          assert.deepEqual(missingRegions.map(({ x, y, width, height }) => ({ x, y, width, height })),
            [{ x: 200, y: 230, width: 27, height: 27 }, { x: 200, y: 420, width: 27, height: 27 }]);
        }
        assert.match(result.warnings, /占位/);
        for (const box of missingRegions) assert.ok(result.warnings.includes(box.href), 'Missing-resource warning omitted its path');
        assert.equal(list.filter(item => ['rect', 'path', 'polygon'].includes(item.type) && item.fill?.toLowerCase() === '#fff7ed' && item.stroke === 'none').length, missingRegions.length,
          'Missing images are not represented by visible native placeholder shapes');
        const outlines = list.filter(item => item.type === 'path' && item.fill?.toLowerCase() === '#c2410c' && item.stroke === 'none');
        assert.equal(outlines.length, missingRegions.length * 2, 'Missing-image borders and crosses must be editable filled paths');
        assert.equal(outlines.filter(item => item.fillRule === 'evenodd').length, missingRegions.length, 'Missing-image borders lost their hollow contour');
        result.missingImages = { replacedWithPlaceholders: true, lossless: false, excludedRegions: missingRegions,
          reason: 'Unavailable relative image references are intentionally represented by visible placeholders.' };
      }
      const excluded = missingRegions.map(box => ({ x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6 }));
      result.fidelity = await compareRasters(page, source, converted, scene.width, scene.height, stem, undefined, excluded);
      result.canvasFidelity = await compareDisplayedCanvas(page, source, scene, stem, excluded);
      const reopened = await reopenJson(page, scene, ' · JSON roundtrip');
      result.jsonRoundtrip = true;
      if (editFiles.includes(file)) result.edits = await exerciseEdits(page, reopened, stem);
      await page.screenshot({ path: join(artifactDir, stem + '-workbench.png') });
      // 07's full-tile pattern becomes a direct image. Chromium resamples that
      // JPEG differently; its bytes/geometry are also checked independently.
      assertFidelity(result.fidelity, file + ' SVG export', 2, file.startsWith('07_') ? .04 : .02);
      assertCanvasFidelity(result.canvasFidelity, file + ' actual Canvas');
      result.passed = true;
    } catch (error) {
      result.passed = false; result.error = String(error);
      await page.screenshot({ path: join(artifactDir, stem + '-failure.png'), fullPage: true }).catch(() => {});
    } finally {
      assert.equal(sha(await readFile(join(sampleDir, file))), result.sourceSha256, 'An original SVG changed during testing');
      results.push(result); await saveReport(); console.log(JSON.stringify(result));
      await context.close(); activePage = undefined;
    }
  }

  if (runSynthetic) {
    const symbol = await newPage();
    const symbolSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="220"><title>Independent symbol viewports</title>
      <defs>
        <clipPath id="symbol-clip"><circle cx="50" cy="40" r="35"/></clipPath>
        <symbol id="glyph" viewBox="0 0 100 80">
          <g clip-path="url(#symbol-clip)">
            <path d="M-10 -10H110V90H-10Z"/>
            <path d="M5 15L95 65M5 65L95 15" fill="none" stroke="#172b4d" stroke-width="4"/>
            <rect x="43" y="10" width="14" height="60" fill="#ffca28"/>
          </g>
        </symbol>
      </defs>
      <use href="#glyph" x="20" y="20" width="180" height="120" fill="#245ab3"/>
      <use href="#glyph" x="245" y="35" width="140" height="160" fill="#d34f60"/>
    </svg>`;
    await importSvg(symbol.page, 'symbol-viewports.svg', symbolSvg);
    const symbolScene = await exportFile(symbol.page), symbolObjects = primitives(symbolScene);
    assert.equal(new Set(symbolObjects.map(item => item.id)).size, symbolObjects.length, 'Symbol instances share primitive IDs');
    const blueInstance = symbolObjects.find(item => item.fill?.toLowerCase() === '#245ab3'), redInstance = symbolObjects.find(item => item.fill?.toLowerCase() === '#d34f60');
    assert.ok(blueInstance && redInstance && blueInstance.id !== redInstance.id, 'Use instances lost separately inherited fills');
    assert.ok(symbolObjects.filter(item => item.clip?.length).length >= 2, 'Symbol instance clips are missing');
    symbolResult = { exported: await compareRasters(symbol.page, symbolSvg, await exportFile(symbol.page, 'svg'), 440, 220, 'symbol-viewports'),
      canvas: await compareDisplayedCanvas(symbol.page, symbolSvg, symbolScene, 'symbol-viewports') };
    assertFidelity(symbolResult.exported, 'Symbol viewBox/use viewport SVG export', 1, .01);
    assertCanvasFidelity(symbolResult.canvas, 'Symbol viewBox/use viewport Canvas');
    await selectPrimitive(symbol.page, symbolScene, blueInstance);
    await symbol.page.getByLabel('填充颜色', { exact: true }).fill('#137e69');
    const editedSymbol = await exportFile(symbol.page), editedInstances = primitives(editedSymbol);
    assert.equal(editedInstances.find(item => item.id === blueInstance.id).fill, '#137e69');
    assert.equal(editedInstances.find(item => item.id === redInstance.id).fill, redInstance.fill, 'Editing one use instance changed another');
    await reopenJson(symbol.page, editedSymbol, ' · symbol JSON roundtrip');
    symbolResult.independentEdit = true; symbolResult.jsonRoundtrip = true;
    await symbol.context.close(); activePage = undefined;
    await saveReport();

    const { page, context } = await newPage();
    const imageUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffc400'; ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#152c63'; ctx.fillRect(0, 0, 8, 8); ctx.fillRect(8, 8, 8, 8);
      return canvas.toDataURL('image/png');
    });
    const effectsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><title>Editable SVG effects</title>
      <defs><clipPath id="circle"><circle cx="95" cy="65" r="60"/></clipPath></defs>
      <g data-module-id="effects-module" transform="translate(25 20)">
        <g id="composite" opacity=".6" clip-path="url(#circle)">
          <rect id="blue-panel" width="160" height="120" fill="#245ab3"/>
          <rect id="red-panel" x="65" y="20" width="130" height="100" fill="#d34f60"/>
          <image id="pixels" x="30" y="40" width="64" height="64" href="${imageUrl}"/>
        </g>
        <text x="20" y="175" font-size="18" font-family="Arial">Layer effects</text>
      </g></svg>`;
    await importSvg(page, 'editable-effects.svg', effectsSvg);
    const effectsScene = await exportFile(page), effectObjects = primitives(effectsScene);
    assert.ok(effectObjects.some(item => item.type === 'group' && Math.abs(item.opacity - .6) < .001), 'Group compositing was flattened into individual opacity');
    assert.ok(effectObjects.some(item => item.clip?.length), 'Native clipping data is missing');
    assert.equal(Object.keys(effectsScene.assets).length, 1);
    const effectsSvgFidelity = await compareRasters(page, effectsSvg, await exportFile(page, 'svg'), 320, 220, 'effects-svg');
    assertFidelity(effectsSvgFidelity, 'Group opacity and clipping SVG export', .5, .01);
    // Wait for the actual image paint, not merely the importer to finish.
    const roi = { x: 52, y: 25, width: 135, height: 115 };
    let normalCanvas;
    await expect.poll(async () => {
      normalCanvas = await canvasRaster(page, effectsScene);
      const result = await compareRasters(page, effectsSvg, normalCanvas, 320, 220, 'effects-normal-canvas', roi);
      return result.meanChannelError;
    }, { timeout: 10000 }).toBeLessThan(2);
    await page.locator('[data-layer-module="effects-module"]').click();
    await page.getByRole('button', { name: '进入模块，编辑内部对象', exact: true }).click();
    const focusedCanvas = await canvasRaster(page, effectsScene);
    const focusFidelity = await compareRasters(page, normalCanvas, focusedCanvas, 320, 220, 'effects-focus', roi);
    assertFidelity(focusFidelity, 'Entering native editing lost clipping or group opacity', .5, .01);
    await page.getByRole('button', { name: '退出内部编辑', exact: true }).click();
    const restoredCanvas = await canvasRaster(page, effectsScene);
    const restoredFidelity = await compareRasters(page, normalCanvas, restoredCanvas, 320, 220, 'effects-restored', roi);
    assertFidelity(restoredFidelity, 'Leaving native editing changed group/image rendering', .5, .01);
    effectsResult = { exported: effectsSvgFidelity, focused: focusFidelity, restored: restoredFidelity,
      edits: await exerciseEdits(page, effectsScene, 'effects') };

    const beforeRejected = await exportFile(page);
    const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`;
    for (const [name, source] of Object.entries({
      'script.svg': wrap('<script>window.compatScriptRan=true</script><rect width="10" height="10"/>'),
      'remote-image.svg': wrap('<image href="https://svg-compat.invalid/image.png" width="100" height="100"/>'),
      'recursive-use.svg': wrap('<defs><g id="loop"><use href="#loop"/></g></defs><use href="#loop"/>'),
      'missing-clip.svg': wrap('<rect width="100" height="100" clip-path="url(#missing)"/>'),
      'broken-image.svg': wrap('<image href="data:image/png;base64,iVBORw0KGgo=" width="100" height="100"/>'),
    })) {
      await page.getByLabel('直接解析 SVG 项目', { exact: true }).setInputFiles({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
      await expect(page.locator('.error-banner')).toBeVisible();
      assert.deepEqual(await exportFile(page), beforeRejected, name + ' changed the current scene despite rejection');
      await page.locator('.error-banner button').last().click();
    }
    assert.equal(await page.evaluate(() => Boolean(window.compatScriptRan)), false);
    await context.close();

    // Stall Canvas image loads after JSON import; releasing old loads after close
    // must never redraw the old document or overwrite its persisted closed state.
    const delayed = await newPage();
    await delayed.page.evaluate(dataUrl => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      window.compatImageSrcDescriptor = descriptor;
      window.compatPendingImages = [];
      window.compatHoldImages = true;
      Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set(value) {
        if (window.compatHoldImages && value === dataUrl) window.compatPendingImages.push({ image: this, value });
        else descriptor.set.call(this, value);
      } });
    }, imageUrl);
    await reopenJson(delayed.page, effectsScene, ' · delayed image');
    await delayed.page.waitForFunction(() => window.compatPendingImages.length > 0, null, { timeout: 10000 });
    await delayed.page.getByRole('button', { name: '关闭项目', exact: true }).click();
    await delayed.page.getByRole('dialog', { name: '关闭当前项目', exact: true }).getByRole('button', { name: '直接关闭', exact: true }).click();
    const releasedImages = await delayed.page.evaluate(async () => {
      window.compatHoldImages = false;
      const queued = window.compatPendingImages.splice(0);
      await Promise.all(queued.map(async ({ image, value }) => {
        window.compatImageSrcDescriptor.set.call(image, value);
        await image.decode().catch(() => {});
      }));
      Object.defineProperty(HTMLImageElement.prototype, 'src', window.compatImageSrcDescriptor);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return queued.length;
    });
    await expect(delayed.page.getByRole('heading', { name: '新建图表', exact: true })).toBeVisible();
    await expect(delayed.page.getByRole('button', { name: '导出', exact: true })).toBeDisabled();
    await expect.poll(() => delayed.page.locator('canvas.lower-canvas').evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 4; i < data.length; i++) if (data[i] !== data[i % 4]) return false;
      return true;
    })).toBe(true);
    const closed = await delayed.page.evaluate(() => JSON.parse(localStorage.getItem('paper-atelier-v1')));
    assert.equal(closed.projectClosed, true); assert.ok(!closed.scene);
    lifecycleResult = { releasedImages, remainsClosed: true };
    await delayed.context.close(); activePage = undefined;
  }

  if (!externalCorpus && files.filter(file => /^(0[1-9]|10)_/.test(file)).length === 10) {
    assert.equal(baselineImageNodes, 32, 'Original ten-sample image-node count changed');
    assert.equal(baselinePayloads.size, 15, 'Original ten-sample unique image payload count changed');
  }
  assert.deepEqual(importedPayloads, sourcePayloads, 'Imported assets did not preserve all source image data');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  assert.deepEqual(apiCalls, [], 'Import/edit/export issued API calls');
  assert.deepEqual(externalCalls, [], 'Import fetched external resources');
  assert.ok(results.every(result => result.passed), 'SVG compatibility failures: ' + results.filter(result => !result.passed).map(result => result.file).join(', '));
  await saveReport();
  console.log(JSON.stringify({ passed: true, files: results.length, sourceImageNodes, uniqueImagePayloads: sourcePayloads.size, effectsResult, symbolResult, lifecycleResult, apiCalls: 0, modelCalls: 0, artifactDir }));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: join(artifactDir, 'compatibility-failure.png'), fullPage: true }).catch(() => {});
  await saveReport();
  throw error;
} finally {
  await browser.close();
}

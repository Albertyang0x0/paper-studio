// Scientific SVG semantics, visual fidelity, safe static conversion, and JSON reuse.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(process.env.PAPER_TEST_NODE_MODULES
  ? join(resolve(process.env.PAPER_TEST_NODE_MODULES), '__svg_scientific_test__.cjs') : import.meta.url);
const { chromium } = require('playwright'), { expect } = require('playwright/test');
const base = process.env.PAPER_TEST_BASE_URL ?? 'http://localhost:8788';
assert.ok(process.env.PAPER_TEST_ROOT, 'Use scripts/test-ui.mjs for isolated test storage');
assert.equal(new URL(base).port, '8788', 'Never use the live workbench for scientific SVG regressions');
const status = await fetch(base + '/api/status').then(response => response.json());
assert.equal(status.dataScope, 'test');
const artifactDir = process.env.PAPER_TEST_SVG_SCIENTIFIC_OUTPUT ?? join(repo, 'test-artifacts', 'svg-scientific');
await mkdir(artifactDir, { recursive: true });
const edge = join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PAPER_TEST_BROWSER ?? (process.platform === 'win32' && existsSync(edge) ? edge : undefined) });
const errors = [], apiCalls = [], externalCalls = [], results = [];
const primitives = scene => {
  const visit = items => items.flatMap(item => [item, ...visit(item.children ?? [])]);
  return visit([...(scene.annotations ?? []), ...scene.modules.flatMap(module => module.elements)]);
};
let activePage;
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1050 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage(); let initialized = false;
  page.on('pageerror', error => errors.push(String(error)));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (/^https?:$/.test(url.protocol) && (url.origin !== new URL(base).origin || initialized && url.pathname.startsWith('/images/'))) {
      externalCalls.push(url.href); return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      if (!initialized) {
        if (url.pathname === '/api/status') return route.fulfill({ json: { ...status, references: [] } });
        if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [] } });
        if (url.pathname === '/api/settings') return route.fulfill({ json: { configured: false, connections: [], defaultConnectionId: '', defaultImageConnectionId: '' } });
        if (url.pathname === '/api/models') return route.fulfill({ json: { models: [] } });
      }
      apiCalls.push(url.href); return route.fulfill({ status: 500, json: { error: 'Scientific SVG conversion must stay local' } });
    }
    return route.continue();
  });
  await page.goto(base + '/figure', { waitUntil: 'networkidle' }); initialized = true; activePage = page;
  return { page, context };
}
async function importSvg(page, filename, source) {
  await page.getByLabel('直接解析 SVG 项目', { exact: true }).setInputFiles({ name: filename, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await page.waitForFunction(() => Boolean(document.querySelector('.error-banner') || document.querySelector('[aria-label="SVG 导入结果"]')), null, { timeout: 30000 });
  assert.deepEqual(await page.locator('.error-banner').allTextContents(), [], filename + ' failed');
  await expect(page.getByRole('button', { name: '导出', exact: true })).toBeEnabled();
  return page.getByRole('status', { name: 'SVG 导入结果', exact: true }).innerText();
}
async function exportFile(page, format = 'json') {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: format === 'json' ? 'JSON 可编辑项目' : 'SVG 矢量图', exact: true }).click();
  const source = await readFile(await (await downloading).path(), 'utf8');
  return format === 'json' ? JSON.parse(source) : source;
}
async function roundtrip(page, scene) {
  const reopened = { ...scene, title: scene.title + ' · JSON roundtrip' };
  await page.locator('input[type=file][accept=".json"]').setInputFiles({ name: 'scientific.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(reopened)) });
  await expect(page.locator('.editor-title')).toHaveText(reopened.title);
  assert.deepEqual(await exportFile(page), reopened, 'JSON changed scientific text, geometry, or effects');
}
async function selectLayer(page, label) {
  const globals = page.locator('.layer-module > button.layer-row:not([data-layer-module]):not([data-layer-connector])').filter({ hasText: label });
  if (await globals.count()) return globals.first().click();
  for (const owner of await page.locator('[data-layer-module]').all()) {
    await owner.click();
    const children = page.locator('.layer-elements button').filter({ hasText: label });
    if (await children.count()) return children.first().click();
  }
  assert.fail('Missing editable native layer: ' + label);
}
async function comparePixels(page, source, converted, width, height, stem, canvasMode = false) {
  const result = await page.evaluate(async ({ source, converted, width, height, canvasMode }) => {
    const lower = document.querySelector('canvas.lower-canvas');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sceneWidth = width, sceneHeight = height;
    let offsetX = 0, offsetY = 0, zoom = 1, cropX = 0, cropY = 0;
    if (canvasMode) {
      const logicalWidth = parseFloat(lower.style.width), logicalHeight = parseFloat(lower.style.height);
      zoom = Math.min((logicalWidth - 68) / width, (logicalHeight - 68) / height, 1);
      const left = (logicalWidth - width * zoom) / 2, top = (logicalHeight - height * zoom) / 2;
      cropX = Math.floor(left); cropY = Math.floor(top); offsetX = left - cropX; offsetY = top - cropY;
      width = Math.ceil(left + width * zoom) - cropX; height = Math.ceil(top + height * zoom) - cropY;
    } else { width = Math.ceil(width); height = Math.ceil(height); }
    async function raster(value, actual = false) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      if (actual) ctx.drawImage(lower, cropX, cropY, width, height, 0, 0, width, height);
      else {
        // Remove the standard declaration before nesting; the importer separately
        // receives the unchanged DOCTYPE and must validate it before parsing.
        const referenceDoc = new DOMParser().parseFromString(value.replace(/<!DOCTYPE[^>]*>/gi, ''), 'image/svg+xml');
        referenceDoc.documentElement.setAttribute('width', String(sceneWidth));
        referenceDoc.documentElement.setAttribute('height', String(sceneHeight));
        const nested = new XMLSerializer().serializeToString(referenceDoc.documentElement);
        const svg = canvasMode ? `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g transform="translate(${offsetX} ${offsetY}) scale(${zoom})">${nested}</g></svg>` : value;
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        try { const image = new Image(); image.src = url; await image.decode(); ctx.drawImage(image, 0, 0, width, height); }
        finally { URL.revokeObjectURL(url); }
      }
      return { canvas, pixels: ctx.getImageData(0, 0, width, height).data };
    }
    const [a, b] = await Promise.all([raster(source), raster(converted, canvasMode)]);
    const diff = document.createElement('canvas'); diff.width = width; diff.height = height;
    const ctx = diff.getContext('2d'), data = ctx.createImageData(width, height);
    let total = 0, changed = 0, count = 0, blurredTotal = 0, blurredChanged = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4; let delta = 0;
      for (let c = 0; c < 3; c++) { const d = Math.abs(a.pixels[i + c] - b.pixels[i + c]); delta += d; data.data[i + c] = Math.min(255, d * 3); }
      data.data[i + 3] = 255;
      if (canvasMode && (x < 2 || y < 2 || x >= width - 2 || y >= height - 2)) continue;
      count++; total += delta; if (delta > 60) changed++;
      let blurred = 0;
      for (let c = 0; c < 3; c++) {
        let sum = 0, neighbors = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const j = ((y + dy) * width + x + dx) * 4 + c; sum += a.pixels[j] - b.pixels[j]; neighbors++;
        }
        blurred += Math.abs(sum / neighbors);
      }
      blurredTotal += blurred; if (blurred > 60) blurredChanged++;
    }
    ctx.putImageData(data, 0, 0);
    return { meanChannelError: total / (count * 3), changedPixelFraction: changed / count, meanBlurredChannelError: blurredTotal / (count * 3),
      blurredChangedPixelFraction: blurredChanged / count, comparedPixels: count, width, height, zoom,
      sourcePng: a.canvas.toDataURL(), convertedPng: b.canvas.toDataURL(), diffPng: diff.toDataURL() };
  }, { source, converted, width, height, canvasMode });
  for (const [field, label] of [['sourcePng', 'source'], ['convertedPng', 'converted'], ['diffPng', 'diff']]) {
    await writeFile(join(artifactDir, stem + '-' + label + '.png'), Buffer.from(result[field].split(',')[1], 'base64')); delete result[field];
  }
  return result;
}
const faithfulCanvas = result => result.meanBlurredChannelError < 3 && result.blurredChangedPixelFraction < .03;
const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240">${body}</svg>`;
const fixtures = [
  { name: 'matplotlib-doctype', source: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" width="240pt" height="120pt" viewBox="0 0 240 120"><title>Matplotlib native glyphs</title>
<defs><style type="text/css">* { stroke-linecap:butt; stroke-linejoin:round; }</style>
<path id="glyph-A" d="M0 24L8 0H14L22 24H16L13 16H9L6 24ZM10 12H12L11 8Z"/>
<clipPath id="plot-clip"><rect x="20" y="12" width="200" height="80"/></clipPath></defs>
<g clip-path="url(#plot-clip)"><path d="M10 75L70 30L130 60L235 20" fill="none" stroke="#245ab3" stroke-width="3"/></g>
<g fill="#253858"><use href="#glyph-A" x="20" y="94"/><use href="#glyph-A" x="50" y="94"/><use href="#glyph-A" x="80" y="94"/></g></svg>`,
    verify(scene) { assert.ok(Math.abs(scene.width - 320) < .01 && Math.abs(scene.height - 160) < .01, 'pt units were not converted to CSS pixels'); assert.ok(primitives(scene).filter(p => p.type === 'path').length >= 4); } },
  { name: 'scientific-css-text', source: wrap(`<title>Scientific CSS and text spacing</title><style>
svg { font: 400 16px/1.4 Arial, sans-serif; }
.scientific text { fill:#253858; }
g[data-series="A"] > text.axis { font:italic 600 20px/1.2 Arial,sans-serif; fill:#b1445b !important; }
.scientific .axis { fill:#245ab3; }
.scientific > text[data-role="spaced"] { letter-spacing:1.5px; }
</style><g class="scientific" data-series="A">
<text class="axis" x="20" y="35" style="fill:#00ff00">Cascade label</text>
<text x="20" y="70" data-role="spaced">Letter spacing</text>
<text x="20" y="105" font-size="18" textLength="230" lengthAdjust="spacingAndGlyphs">Compressed glyphs</text>
<text x="20" y="140" font-size="18" textLength="250" lengthAdjust="spacing">Spaced labels</text>
<text x="20" y="180" font-size="20">Base<tspan font-size="10" dy=".5em">sub</tspan><tspan font-size="20" dy="-.25em"> next</tspan></text>
</g>`), verify(scene) {
    const list = primitives(scene), axis = list.find(p => p.text === 'Cascade label'), spacing = list.find(p => p.text === 'Letter spacing');
    assert.ok(axis && axis.fill.toLowerCase() === '#b1445b' && axis.italic && axis.fontWeight === 600 && Math.abs(axis.fontSize - 20) < .01, 'CSS selector/shorthand/important cascade changed');
    assert.ok(spacing && Math.abs(spacing.letterSpacing - 1.5) < .001, 'Editable letter spacing is missing');
    assert.ok(list.some(p => p.text === 'Compressed glyphs' && p.scaleX && Math.abs(p.scaleX - 1) > .01), 'spacingAndGlyphs did not preserve native horizontal scaling');
    assert.ok(list.some(p => p.text === 'Spaced labels' && p.letterSpacing > 1.5), 'textLength spacing did not become editable letter spacing');
    assert.ok(list.some(p => p.text?.includes('sub')), 'Relative-em tspan text was lost');
  } },
  { name: 'text-whitespace-and-inheritance', source: wrap(`<title>Text and CSS inheritance boundaries</title><style>svg { fill:red; font-family:Arial; font-size:22px; } [style] rect { fill:blue; }</style>
<text x="20" y="40" fill="#245ab3"><tspan>A</tspan> <tspan fill="red">B</tspan></text>
<g font-size="40" letter-spacing=".1em"><text x="20" y="100" font-size="20">Inherited spacing</text></g>
<rect x="20" y="145" width="110" height="50"/>`),
    verify(scene) {
      const list = primitives(scene), texts = list.filter(p => p.type === 'text');
      assert.equal(texts.filter(p => p.text !== 'Inherited spacing').map(p => p.text).join(''), 'A B', 'The whitespace-only text node between tspans was lost');
      const inherited = texts.find(p => p.text === 'Inherited spacing');
      assert.ok(inherited && inherited.fontSize === 20 && Math.abs(inherited.letterSpacing - 4) < .001, 'Inherited em letter spacing was recomputed using the child font size');
      assert.equal(list.find(p => p.type === 'rect').fill?.toLowerCase(), '#ff0000', 'CSS matching saw style attributes created during normalization');
    } },
  { name: 'linear-gradient-reference-inheritance', source: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="420" height="240"><title>Gradient reference chains and overrides</title><defs>
<linearGradient id="palette"><stop offset="0" stop-color="#245ab3"/><stop offset="1" stop-color="#b1445b"/></linearGradient>
<linearGradient id="base" href="#palette" gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="120" y2="20" gradientTransform="translate(5 0)"/>
<linearGradient id="middle" xlink:href="#base"/>
<linearGradient id="derived" href="#middle" x2="180" gradientTransform="translate(10 0)"/>
<linearGradient id="own-stops" href="#base" x1="230" x2="390" gradientTransform="translate(0 0)"><stop offset="0" stop-color="#008855"/><stop offset="1" stop-color="#ffcc00"/></linearGradient>
<linearGradient id="bbox" href="#base" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="1" gradientTransform="matrix(1 0 0 1 0 0)"/>
</defs><rect x="20" y="20" width="180" height="70" fill="url(#derived)"/><rect x="230" y="20" width="160" height="70" fill="url(#own-stops)"/><rect x="20" y="120" width="180" height="80" fill="url(#bbox)"/></svg>`,
    verify(scene) {
      const gradients = primitives(scene).filter(p => p.gradient).map(p => p.gradient);
      assert.equal(gradients.length, 3, 'Referenced gradients did not remain editable native fills');
      const [inherited, own, bbox] = gradients;
      assert.ok(Math.abs(inherited.x1 - 10 / 180) < .0001 && Math.abs(inherited.x2 - 170 / 180) < .0001, 'Gradient units, child coordinates, or child transform override changed');
      assert.deepEqual(inherited.stops.map(stop => stop.color.toLowerCase()), ['#245ab3', '#b1445b'], 'Reference chain lost inherited stops');
      assert.deepEqual(own.stops.map(stop => stop.color.toLowerCase()), ['#008855', '#ffcc00'], 'Own stops must replace inherited stops');
      assert.ok(Math.abs(bbox.x1) < .0001 && Math.abs(bbox.y1) < .0001 && Math.abs(bbox.x2 - 1) < .0001 && Math.abs(bbox.y2 - 1) < .0001, 'Child objectBoundingBox override was lost');
    } },
  { name: 'empty-text-span-semantics', source: wrap(`<title>Empty spans have no addressable characters</title><g font-family="Arial" font-size="24" fill="#253858">
<text x="20" y="40"><tspan baseline-shift="sub" x="300" dy="50"/>Empty<tspan baseline-shift="super" x="340" dx="80"/><tspan> span</tspan></text>
<text x="20" y="90"><tspan>Nested</tspan><tspan baseline-shift="sub"><tspan x="300" dy="80"/></tspan><tspan> empty</tspan></text>
<text x="20" y="140" baseline-shift="sub"/>
<text x="20" y="190" xml:space="preserve">A<tspan>  </tspan>B</text></g>`),
    verify(scene) {
      const texts = primitives(scene).filter(p => p.type === 'text');
      assert.equal(texts.map(p => p.text).join(''), 'Empty spanNested emptyA  B', 'Empty spans or preserved whitespace changed visible text');
      assert.ok(texts.every(p => p.text.length > 0), 'Empty text nodes created editable phantom layers');
      assert.ok(texts.every(p => p.x < 250), 'An empty span moved following addressable characters');
    } },
  { name: 'editable-underlined-text', source: wrap(`<title>Editable underline and inherited decoration</title><style>.underlined { text-decoration:underline; }</style>
<g font-family="Arial" font-size="24" fill="#245ab3"><text class="underlined" x="20" y="40">Editable underline</text>
<g text-decoration="underline"><text x="20" y="90">Inherited underline</text><text x="20" y="140">Ancestor<tspan text-decoration="none"> still underlined</tspan></text></g>
<text x="20" y="190">Plain text</text><text x="300" y="190" xml:space="preserve" text-decoration="underline">   </text></g>`),
    verify(scene, warnings, svg) {
      const texts = primitives(scene).filter(p => p.type === 'text');
      assert.ok(texts.find(p => p.text === 'Editable underline')?.underline, 'CSS underline is not editable text');
      assert.ok(texts.find(p => p.text === 'Inherited underline')?.underline, 'Ancestor underline was not propagated');
      assert.ok(texts.filter(p => /Ancestor|still underlined/.test(p.text)).every(p => p.underline), 'A child none incorrectly cancelled ancestor decoration');
      assert.ok(!texts.find(p => p.text === 'Plain text')?.underline, 'Underline leaked to unrelated text');
      assert.ok(texts.find(p => p.text === '   ')?.underline, 'Preserved spaces-only text lost its visible underline');
      assert.match(svg, /text-decoration="underline"/, 'SVG export omitted text underline');
    },
    async edit(page) {
      await selectLayer(page, 'Editable underline');
      await page.getByLabel('文字', { exact: true }).fill('Edited longer underline');
      const scene = await exportFile(page), text = primitives(scene).find(p => p.text === 'Edited longer underline');
      assert.ok(text?.underline && text.type === 'text', 'Editing text lost underline or converted it to an image');
      await roundtrip(page, scene);
      const svg = await exportFile(page, 'svg');
      assert.ok(await page.evaluate(svg => Array.from(new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')).some(node => node.textContent === 'Edited longer underline' && node.getAttribute('text-decoration') === 'underline'), svg), 'Edited underline did not survive JSON reopening and SVG export');
    } },
  { name: 'inkscape-paint-order-markers', source: `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="35mm" viewBox="0 0 80 35"><title>Inkscape scientific labels</title>
<defs><rect id="flow-region" x="5" y="4" width="70" height="15"/><marker id="arrow" viewBox="0 0 6 6" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L6 3L0 6Z" fill="#b1445b"/></marker></defs>
<rect x="4" y="3" width="72" height="16" fill="#ffca28" stroke="#245ab3" stroke-width="4" style="paint-order:stroke fill markers"/>
<text style="font-family:Arial;font-size:5px;font-style:normal;font-variant:normal;font-stretch:normal;line-height:1.2;-inkscape-font-specification:Arial;white-space:pre;shape-inside:url(#flow-region);paint-order:stroke fill markers" fill="#253858" stroke="#fff" stroke-width=".5"><tspan x="8" y="13">Flow  fallback</tspan></text>
<path d="M8 27L36 27L68 27" fill="none" stroke="#245ab3" stroke-width="1" marker-mid="url(#arrow)" marker-end="url(#arrow)"/></svg>`,
    verify(scene) { const list = primitives(scene); assert.ok(Math.abs(scene.width - 80 * 96 / 25.4) < .01, 'mm units changed'); assert.ok(list.some(p => p.type === 'rect' && p.paintOrder === 'stroke fill')); assert.ok(list.some(p => p.text === 'Flow  fallback'), 'Explicit tspan fallback or whitespace was lost'); } },
  { name: 'static-hover', source: wrap(`<title>Static hover illustration</title><rect id="hover-node" x="25" y="25" width="180" height="100" fill="#245ab3" stroke="#253858" stroke-width="2" stroke-dasharray="5 3"><set attributeName="stroke-width" to="8" begin="hover-node.mouseover" end="hover-node.mouseout"/><set attributeName="stroke-dasharray" to="0" begin="hover-node.mouseover" end="hover-node.mouseout"/></rect><text x="25" y="165" font-size="20" font-family="Arial">Static initial state</text>`),
    verify(scene, warnings, svg) { const box = primitives(scene).find(p => p.type === 'rect'); assert.equal(box.strokeWidth, 2); assert.deepEqual(box.dash, [5, 3]); assert.match(warnings, /静态|悬停|交互/); assert.ok(!/<set\b/i.test(svg), 'Export retained active hover behavior'); } },
  { name: 'diagram-marker-opacity-compositing', source: wrap(`<title>Translucent arrow between diagram nodes</title><defs><marker id="large-arrow" viewBox="0 0 30 30" markerWidth="45" markerHeight="45" refX="25" refY="15" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L30 15L0 30Z" fill="#b1445b"/></marker></defs>
<rect x="20" y="70" width="380" height="100" fill="#e4f0e8"/><rect x="35" y="85" width="100" height="70" fill="#c3d5ee"/><rect x="285" y="85" width="100" height="70" fill="#edd1db"/>
<path id="opacity-wire" d="M150 120L265 120" fill="none" stroke="#245ab3" stroke-width="18" marker-end="url(#large-arrow)" opacity=".45"/>`),
    verify(scene) {
      const group = primitives(scene).find(p => p.type === 'group' && p.id.includes('opacity-wire'));
      assert.ok(group && Math.abs(group.opacity - .45) < .0001, 'The arrow and its shaft must share one opacity composite');
      assert.equal(group.children.length, 2, 'The composite must contain the native shaft and arrowhead');
      assert.ok(group.children.every(p => p.type === 'path' && (p.opacity ?? 1) === 1), 'Opacity was applied separately to overlapping shaft and arrowhead');
    } },
  { name: 'missing-relative-image', source: wrap(`<title>Explicit missing resource placeholder</title><image href="images/unavailable.svg" x="24" y="22" width="80" height="60"/><rect x="145" y="22" width="110" height="60" fill="#245ab3"/><text x="24" y="130" font-size="20" font-family="Arial">Unchanged scientific label</text>`),
    // The unavailable image's content cannot be reconstructed. This reference
    // checks the declared placeholder contract, not fidelity to missing artwork.
    // Keep the prior stroked reference: the new filled outlines must retain its
    // visible border/cross while permitting an affine transform during import.
    expected: wrap(`<rect x="25" y="23" width="78" height="58" fill="#fff7ed" stroke="#c2410c" stroke-width="2"/><path d="M25 23L103 81M103 23L25 81" fill="none" stroke="#c2410c" stroke-width="2"/><rect x="145" y="22" width="110" height="60" fill="#245ab3"/><text x="24" y="130" font-size="20" font-family="Arial">Unchanged scientific label</text>`),
    verify(scene, warnings, svg) {
      const list = primitives(scene); assert.match(warnings, /占位/); assert.match(warnings, /images\/unavailable\.svg/);
      assert.equal(list.filter(p => ['rect', 'path', 'polygon'].includes(p.type) && p.fill?.toLowerCase() === '#fff7ed' && p.stroke === 'none').length, 1, 'Missing resource has no explicit visible placeholder');
      const outlines = list.filter(p => p.type === 'path' && p.fill?.toLowerCase() === '#c2410c' && p.stroke === 'none');
      assert.equal(outlines.length, 2, 'Missing resource must retain editable filled border and cross paths');
      assert.equal(outlines.filter(p => p.fillRule === 'evenodd').length, 1, 'Missing-image border lost its hollow contour');
      assert.ok(!list.some(p => p.type === 'image') && !Object.keys(scene.assets ?? {}).length, 'Missing resource was silently replaced by an invented asset');
      assert.ok(!/<image\b/i.test(svg), 'Export retains a broken image resource reference');
    } },
];
const missingFixture = fixtures.find(fixture => fixture.name === 'missing-relative-image');
fixtures.push({ ...missingFixture, name: 'missing-relative-image-shear',
  source: wrap(`<title>Affine missing resource placeholder</title><g transform="matrix(1 .1 .45 .65 30 40)" opacity=".7"><image href="images/unavailable.svg" x="24" y="22" width="80" height="60"/></g><rect x="220" y="22" width="110" height="60" fill="#245ab3"/>`),
  expected: wrap(`<g transform="matrix(1 .1 .45 .65 30 40)" opacity=".7"><rect x="25" y="23" width="78" height="58" fill="#fff7ed" stroke="#c2410c" stroke-width="2"/><path d="M25 23L103 81M103 23L25 81" fill="none" stroke="#c2410c" stroke-width="2"/></g><rect x="220" y="22" width="110" height="60" fill="#245ab3"/>`) });
fixtures.push({ ...missingFixture, name: 'missing-image-ignores-paint-opacity',
  source: wrap(`<title>Image opacity is independent of vector paint opacity</title><g fill-opacity="0" stroke-opacity="0" opacity=".5"><image href="images/unavailable.svg" x="24" y="22" width="80" height="60" fill-opacity="0" stroke-opacity="0"/></g><rect x="145" y="22" width="110" height="60" fill="#245ab3"/>`),
  expected: wrap(`<g opacity=".5"><rect x="25" y="23" width="78" height="58" fill="#fff7ed" stroke="#c2410c" stroke-width="2"/><path d="M25 23L103 81M103 23L25 81" fill="none" stroke="#c2410c" stroke-width="2"/></g><rect x="145" y="22" width="110" height="60" fill="#245ab3"/>`),
  verify(scene, warnings, svg) {
    missingFixture.verify(scene, warnings, svg);
    assert.ok(primitives(scene).some(p => p.type === 'group' && Math.abs(p.opacity - .5) < .001), 'Missing-image group opacity was not retained');
  } });
async function saveReport() { await writeFile(join(artifactDir, 'report.json'), JSON.stringify({ results, errors, apiCalls, externalCalls }, null, 2)); }

try {
  for (const fixture of fixtures) {
    const { page, context } = await newPage(), result = { name: fixture.name };
    try {
      const warnings = await importSvg(page, fixture.name + '.svg', fixture.source);
      const scene = await exportFile(page), svg = await exportFile(page, 'svg');
      result.warnings = warnings; fixture.verify(scene, warnings, svg); result.semantics = true;
      if (fixture.expected) result.comparison = { lossless: false, reference: 'Explicit native missing-resource placeholder; unavailable artwork is not reconstructed.' };
      await writeFile(join(artifactDir, fixture.name + '-native.json'), JSON.stringify(scene, null, 2));
      await writeFile(join(artifactDir, fixture.name + '-converted.svg'), svg);
      const reference = fixture.expected ?? fixture.source;
      result.exported = await comparePixels(page, reference, svg, scene.width, scene.height, fixture.name);
      await page.getByRole('button', { name: '适应画板', exact: true }).click();
      await expect.poll(async () => { result.canvas = await comparePixels(page, reference, svg, scene.width, scene.height, fixture.name + '-canvas', true); return faithfulCanvas(result.canvas); }, { timeout: 10000, intervals: [200, 500, 1000] }).toBe(true).catch(() => {});
      await roundtrip(page, scene); result.jsonRoundtrip = true;
      assert.ok(result.exported.meanChannelError < 2 && result.exported.changedPixelFraction < .02, 'Scientific SVG export differs: ' + JSON.stringify(result.exported));
      assert.ok(faithfulCanvas(result.canvas), 'Scientific Canvas differs: ' + JSON.stringify(result.canvas));
      if (fixture.edit) { await fixture.edit(page); result.editableRoundtrip = true; }
      result.passed = true;
    } catch (error) { result.passed = false; result.error = String(error); await page.screenshot({ path: join(artifactDir, fixture.name + '-failure.png') }).catch(() => {}); }
    finally { results.push(result); await saveReport(); console.log(JSON.stringify(result)); await context.close(); activePage = undefined; }
  }

  const { page, context } = await newPage();
  await importSvg(page, 'preserved-project.svg', wrap('<title>Preserve current scientific project</title><rect x="20" y="20" width="180" height="100" fill="#245ab3"/>'));
  const before = await exportFile(page);
  const unsafe = {
    'internal-entity.svg': '<!DOCTYPE svg [<!ENTITY boom "altered">]>' + wrap('<text x="10" y="20">&boom;</text>'),
    'external-entity.svg': '<!DOCTYPE svg [<!ENTITY steal SYSTEM "https://svg-scientific.invalid/secret">]>' + wrap('<text x="10" y="20">&steal;</text>'),
    'external-dtd.svg': '<!DOCTYPE svg SYSTEM "https://svg-scientific.invalid/evil.dtd">' + wrap('<rect width="10" height="10"/>'),
    'active-code.svg': wrap('<script>window.scientificCodeExecuted=true</script><rect width="10" height="10"/>'),
    'active-event.svg': wrap('<rect width="10" height="10" onload="window.scientificCodeExecuted=true"/>'),
    'active-link-set.svg': wrap('<a href="#target"><set attributeName="href" to="javascript:alert(1)" begin="mouseover"/><rect id="target" width="10" height="10"/></a>'),
    'remote-image.svg': wrap('<image href="https://svg-scientific.invalid/image.png" width="20" height="20"/>'),
    'css-import.svg': wrap('<style>@import url(https://svg-scientific.invalid/style.css);</style><rect width="10" height="10"/>'),
    'css-font-resource.svg': wrap('<style>@font-face {font-family:Remote;src:url(https://svg-scientific.invalid/font.woff2)}</style><text x="10" y="20">Blocked</text>'),
    'xml-stylesheet.svg': '<?xml-stylesheet href="https://svg-scientific.invalid/style.css"?>' + wrap('<rect width="10" height="10"/>'),
    'gradient-reference-cycle.svg': wrap('<defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs><rect width="120" height="80" fill="url(#a)"/>'),
    'gradient-reference-missing.svg': wrap('<defs><linearGradient id="a" href="#missing"/></defs><rect width="120" height="80" fill="url(#a)"/>'),
    'gradient-reference-external.svg': wrap('<defs><linearGradient id="a" href="https://svg-scientific.invalid/paint.svg#gradient"/></defs><rect width="120" height="80" fill="url(#a)"/>'),
    'empty-text-active-event.svg': wrap('<text x="20" y="40">Visible<tspan baseline-shift="sub" onload="window.scientificCodeExecuted=true"/></text>'),
    'empty-text-active-script.svg': wrap('<text x="20" y="40">Visible<tspan baseline-shift="sub"><script/></tspan></text>'),
    'visible-baseline-shift.svg': wrap('<text x="20" y="40" font-family="Arial" font-size="24">Base<tspan baseline-shift="sub">sub</tspan></text>'),
    'underlined-visible-stroke.svg': wrap('<text x="20" y="40" font-family="Arial" font-size="24" text-decoration="underline" fill="#245ab3" stroke="#b1445b" stroke-width="2">Stroked underline</text>'),
    'inherited-underline-font-change.svg': wrap('<text x="20" y="40" font-family="Arial" font-size="24" text-decoration="underline">Parent<tspan font-size="12">smaller</tspan></text>'),
    'inherited-underline-paint-change.svg': wrap('<text x="20" y="40" font-family="Arial" font-size="24" fill="#245ab3" text-decoration="underline">Parent<tspan fill="#b1445b">different paint</tspan></text>'),
  };
  for (const [name, source] of Object.entries(unsafe)) {
    await page.getByLabel('直接解析 SVG 项目', { exact: true }).setInputFiles({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
    await expect(page.locator('.error-banner')).toBeVisible();
    assert.deepEqual(await exportFile(page), before, name + ' damaged the active project');
    await page.locator('.error-banner button').last().click();
  }
  assert.equal(await page.evaluate(() => Boolean(window.scientificCodeExecuted)), false);
  results.push({ name: 'unsafe-inputs-preserve-project', rejected: Object.keys(unsafe), passed: true });
  await context.close(); activePage = undefined;
  assert.deepEqual(errors, [], 'Browser errors'); assert.deepEqual(apiCalls, [], 'Unexpected model/API calls'); assert.deepEqual(externalCalls, [], 'Unexpected resource requests');
  await saveReport(); assert.ok(results.every(result => result.passed), 'Scientific SVG failures: ' + results.filter(result => !result.passed).map(result => result.name).join(', '));
  console.log(JSON.stringify({ passed: true, cases: results.length, apiCalls: 0, externalCalls: 0, artifactDir }));
} catch (error) {
  await saveReport(); if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: join(artifactDir, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser.close(); }

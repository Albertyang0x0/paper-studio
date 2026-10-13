import test from "node:test";
import assert from "node:assert/strict";
import type { Primitive, StyleTokens } from "../../shared/types";
import { svgUnderlineKey, svgUnderlineMetrics, svgUnderlineProbe } from "../../src/figure/svg-text-decoration";

const style = { font: "Arial", bodySize: 24 } as StyleTokens;
const text: Primitive = { id: "text", type: "text", x: 0, y: 0, text: "Label", underline: true };

test("underline metrics recover antialiased line coverage in local units", () => {
  const width = 10, height = 20, pixels = new Uint8Array(width * height * 4);
  // At density 4, top is 2.375 and thickness is 0.75 local pixels.
  for (const [row, alpha] of [[9, 128], [10, 255], [11, 255], [12, 128]]) {
    for (let x = 2; x < width - 2; x++) pixels[(row * width + x) * 4 + 3] = alpha;
  }
  // The probe's capital glyph ink above the baseline must not become a line.
  for (let x = 2; x < width - 2; x++) pixels[(3 * width + x) * 4 + 3] = 255;
  const metrics = svgUnderlineMetrics(pixels, width, height, { baseline: 2, density: 4, scale: 2 });
  assert.ok(Math.abs(metrics.offset - .75) < .002);
  assert.ok(Math.abs(metrics.thickness - 1.5) < .002);
  assert.throws(() => svgUnderlineMetrics(new Uint8Array(pixels.length), width, height,
    { baseline: 2, density: 4, scale: 1 }), /无法测量/);
});

test("font probe keys are shared across labels and distinguish decoration metrics", () => {
  const base = svgUnderlineKey(text, style);
  assert.equal(svgUnderlineKey({ ...text, text: "Edited", x: 30, fill: "red", scaleX: 2 }, style), base);
  assert.equal(svgUnderlineKey({ ...text, fontFamily: " Arial ", fontSize: 24, fontWeight: 400, italic: false }, style), base);
  for (const change of [{ fontFamily: "Times New Roman" }, { fontSize: 30 }, { fontWeight: 700 }, { italic: true }]) {
    assert.notEqual(svgUnderlineKey({ ...text, ...change }, style), base);
  }
});

test("underline probes use only bounded embedded SVG and escape font family metadata", () => {
  const probe = svgUnderlineProbe({ ...text, fontFamily: 'Arial" href="https://example.com/font', fontSize: 10000 }, style);
  assert.ok(probe.width * probe.height <= 100_000);
  assert.match(probe.source, /^data:image\/svg\+xml;charset=utf-8,/);
  const source = decodeURIComponent(probe.source.slice(probe.source.indexOf(",") + 1));
  assert.match(source, /font-family="Arial&quot; href=&quot;https:\/\/example.com\/font"/);
  assert.doesNotMatch(source, /<image|<use|<script|<style|\s+href="/);
  assert.match(source, /xml:space="preserve"/);
  assert.match(source, />M+<\/text>/, "actual glyphs prevent Chromium's whitespace-only image optimization");
});

test("font calibration preserves native hinting size and validates JSON-provided font sizes", () => {
  for (const fontSize of [10, 24, 83, 500, 10000]) {
    const probe = svgUnderlineProbe({ ...text, fontSize }, style);
    const source = decodeURIComponent(probe.source.slice(probe.source.indexOf(",") + 1));
    assert.equal(probe.density, 1, "scaling the probe changes browser underline hinting");
    assert.equal(probe.scale, 1);
    assert.ok(Number.isInteger(probe.baseline));
    assert.match(source, new RegExp(`font-size="${fontSize}"`));
    assert.ok(source.includes(`width="${probe.width}" height="${probe.height}" viewBox="0 0 ${probe.width} ${probe.height}"`),
      "probe raster dimensions must equal local SVG dimensions");
  }
  for (const fontSize of [0, -1, Infinity, NaN, 10001]) {
    assert.throws(() => svgUnderlineProbe({ ...text, fontSize }, style), /下划线字号/);
  }
});

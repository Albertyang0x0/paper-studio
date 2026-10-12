import type { Primitive, StyleTokens } from "../../shared/types";
import { escapeXml } from "../../shared/svg";

export type SvgUnderlineMetrics = { offset: number; thickness: number };

export function svgUnderlineKey(text: Primitive, style: StyleTokens): string {
  return JSON.stringify([(text.fontFamily ?? style.font).trim(), text.fontSize ?? style.bodySize,
    text.fontWeight ?? 400, text.italic ?? false]);
}

/** A small, local SVG asks the browser to use the selected font's underline metrics. */
export function svgUnderlineProbe(text: Primitive, style: StyleTokens) {
  const size = text.fontSize ?? style.bodySize;
  if (!Number.isFinite(size) || size <= 0 || size > 10000) throw new Error("下划线字号必须在 0 到 10000 之间。");
  // Measure at the original font size: scaling the SVG before measuring changes
  // browser font hinting and rounds the underline position at a different size.
  // A narrow strip bounds even the largest accepted font to 80,128 pixels.
  const fontSize = size, density = 1;
  const baseline = Math.ceil(fontSize * .2 + 4), width = 16, height = Math.ceil(fontSize * .5 + 8);
  // Chromium can omit a whitespace-only text image. Capitals without descenders
  // force painting, and scanning below the baseline isolates the decoration.
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * density}" height="${height * density}" viewBox="0 0 ${width} ${height}"><text x="0" y="${baseline}" xml:space="preserve" fill="black" font-family="${escapeXml(text.fontFamily ?? style.font)}" font-size="${fontSize}" font-weight="${text.fontWeight ?? 400}" font-style="${text.italic ? "italic" : "normal"}" text-decoration="underline">MMMMMMMMMMMMMMMMMMMM</text></svg>`;
  return { source: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source),
    width: width * density, height: height * density, baseline, density, scale: size / fontSize };
}

/** Recover the line's top and thickness from antialiased alpha coverage. */
export function svgUnderlineMetrics(
  pixels: ArrayLike<number>, width: number, height: number,
  probe: Pick<ReturnType<typeof svgUnderlineProbe>, "baseline" | "density" | "scale">,
): SvgUnderlineMetrics {
  let first = -1, firstCoverage = 0, coverage = 0;
  for (let y = Math.max(0, Math.ceil(probe.baseline * probe.density)); y < height; y++) {
    let alpha = 0;
    for (let x = 2; x < width - 2; x++) alpha = Math.max(alpha, pixels[(y * width + x) * 4 + 3]);
    if (alpha > 0) {
      if (first < 0) { first = y; firstCoverage = alpha / 255; }
      coverage += alpha / 255;
    }
  }
  if (first < 0 || coverage <= 0) throw new Error("无法测量 SVG 字体下划线。");
  return { offset: ((first + 1 - firstCoverage) / probe.density - probe.baseline) * probe.scale,
    thickness: coverage / probe.density * probe.scale };
}

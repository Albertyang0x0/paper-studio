import { Resvg } from "@resvg/resvg-js";
import type { Primitive, StyleTokens } from "../shared/types";
import { primitiveSvg } from "../shared/svg";

// Measure the *rendered* vector module, including true font and path bounds.
// An extended transparent canvas detects spill instead of silently clipping it.
export function renderedBounds(
  elements: Primitive[],
  width: number,
  height: number,
  style: StyleTokens,
) {
  const margin = 160,
    w = Math.ceil(width + margin * 2),
    h = Math.ceil(height + margin * 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g transform="translate(${margin} ${margin})">${elements.map((e) => primitiveSvg(e, style)).join("")}</g></svg>`;
  const image = new Resvg(svg, {
      font: { loadSystemFonts: true, defaultFontFamily: style.font },
    }).render(),
    pixels = image.pixels;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (pixels[(y * w + x) * 4 + 3] > 10) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return x1 < 0
    ? null
    : {
        x: x0 - margin,
        y: y0 - margin,
        width: x1 - x0 + 1,
        height: y1 - y0 + 1,
        right: x1 - margin,
        bottom: y1 - margin,
      };
}

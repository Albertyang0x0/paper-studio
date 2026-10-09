import { createCanvas } from "@napi-rs/canvas";
import type { Primitive, StyleTokens } from "../shared/types";
import { displayMath } from "../shared/math-text";
import { expandPrimitive } from "../shared/assets";
import {canvasFont} from './font-metrics';

type Matrix = [number, number, number, number, number, number];
export type TextBox = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  effectiveFontSize: number;
};
const ctx = createCanvas(1, 1).getContext("2d");
const identity: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const point = (m: Matrix, x: number, y: number) => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

// Bounds describe visible glyphs, not the model's guessed text width. Parent
// transforms are included so the same check also catches tiny nested labels.
export function textBoxes(
  items: Primitive[],
  style: StyleTokens,
  parent: Matrix = identity,
): TextBox[] {
  const result: TextBox[] = [];
  for (const raw of items) {
    const e = expandPrimitive(raw),
      angle = ((e.rotation ?? 0) * Math.PI) / 180,
      sx = e.scaleX ?? 1,
      sy = e.scaleY ?? 1,
      matrix = multiply(parent, [
        Math.cos(angle) * sx,
        Math.sin(angle) * sx,
        -Math.sin(angle) * sy,
        Math.cos(angle) * sy,
        e.x,
        e.y,
      ]);
    if (e.type === "group") {
      result.push(...textBoxes(e.children ?? [], style, matrix));
      continue;
    }
    if (e.type !== "text" || !e.text || e.opacity === 0 || e.fill === "none")
      continue;
    const size = e.fontSize ?? style.bodySize;
    ctx.font = canvasFont(e.fontFamily??style.font,size,e.fontWeight??400,!!e.italic);
    displayMath(e.text)
      .split("\n")
      .forEach((line, index) => {
        if (!line.trim()) return;
        const metrics = ctx.measureText(line),
          anchor =
            e.align === "center"
              ? (e.width ?? 0) / 2
              : e.align === "right"
                ? (e.width ?? 0)
                : 0,
          left =
            anchor -
            (e.align === "center"
              ? metrics.width / 2
              : e.align === "right"
                ? metrics.width
                : 0) -
            metrics.actualBoundingBoxLeft,
          top =
            size * 0.92 + index * size * 1.24 - metrics.actualBoundingBoxAscent,
          width =
            metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
          height =
            metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
          corners = [
            point(matrix, left, top),
            point(matrix, left + width, top),
            point(matrix, left, top + height),
            point(matrix, left + width, top + height),
          ],
          xs = corners.map((p) => p.x),
          ys = corners.map((p) => p.y);
        result.push({
          id: e.id,
          text: line,
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
          effectiveFontSize: size * Math.hypot(matrix[2], matrix[3]),
        });
      });
  }
  return result;
}

export function textCollisions(
  items: Primitive[],
  style: StyleTokens,
): string[] {
  const boxes = textBoxes(items, style),
    pairs = new Map<string, string>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      if (a.id === b.id) continue;
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
        h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (
        w > 2 &&
        h > 2 &&
        w * h > Math.min(a.width * a.height, b.width * b.height) * 0.2
      ) {
        pairs.set(
          [a.id, b.id].sort().join("|"),
          `${a.id} (${JSON.stringify(a.text)}) overlaps ${b.id} (${JSON.stringify(b.text)})`,
        );
      }
    }
  }
  return [...pairs.values()];
}

import type { FigureScene } from "../shared/types";
import { renderedBounds } from "./bounds";
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box, gap = 0) =>
  a.x < b.x + b.width + gap &&
  a.x + a.width + gap > b.x &&
  a.y < b.y + b.height + gap &&
  a.y + a.height + gap > b.y;

// A deterministic final pass owns geometric invariants, not scientific choices.
// It never rewrites text, replaces a method, or manufactures a missing module.
export function settleGlobalLayout(original: FigureScene): FigureScene {
  const scene = structuredClone(original);
  const headers = scene.regions.map((r) => ({
    x: r.x + 12,
    y: r.y + 8,
    width: Math.min(
      r.width - 24,
      r.title.length * scene.style.titleSize * 0.57,
    ),
    height: scene.style.titleSize * 1.24 + 8,
  }));
  for (const m of scene.modules) {
    if (m.locked) continue;
    const region = scene.regions
      .filter(
        (r) =>
          m.x >= r.x &&
          m.x + m.width <= r.x + r.width &&
          m.y + m.height / 2 >= r.y &&
          m.y + m.height / 2 <= r.y + r.height,
      )
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (!region) continue;
    const minimum = region.y + 12 + scene.style.titleSize * 1.24 + 8;
    if (m.y < minimum && minimum + m.height <= region.y + region.height - 2) {
      const proposed = { ...m, y: minimum };
      if (
        !scene.modules.some(
          (other) => other.id !== m.id && overlaps(proposed, other, 4),
        )
      )
        m.y = minimum;
    }
  }
  const placed: Box[] = [];
  for (const e of scene.annotations) {
    const bounds = renderedBounds([e], scene.width, scene.height, scene.style);
    if (!bounds) continue;
    const occupied = [...scene.modules, ...headers, ...placed];
    if (e.locked || !occupied.some((box) => overlaps(bounds, box, 4))) {
      placed.push(bounds);
      continue;
    }
    const candidates = [
      { x: bounds.x, y: 8 },
      { x: bounds.x, y: scene.height - bounds.height - 8 },
    ];
    for (const box of occupied)
      candidates.push(
        { x: box.x - bounds.width - 8, y: bounds.y },
        { x: box.x + box.width + 8, y: bounds.y },
        { x: bounds.x, y: box.y - bounds.height - 8 },
        { x: bounds.x, y: box.y + box.height + 8 },
      );
    const valid = candidates
      .filter(
        (p) =>
          p.x >= 8 &&
          p.y >= 8 &&
          p.x + bounds.width <= scene.width - 8 &&
          p.y + bounds.height <= scene.height - 8 &&
          !occupied.some((box) => overlaps({ ...bounds, ...p }, box, 4)),
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - bounds.x, a.y - bounds.y) -
          Math.hypot(b.x - bounds.x, b.y - bounds.y),
      );
    if (valid[0]) {
      e.x += valid[0].x - bounds.x;
      e.y += valid[0].y - bounds.y;
      placed.push({ ...bounds, ...valid[0] });
    } else placed.push(bounds);
  }
  return scene;
}

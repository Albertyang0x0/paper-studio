import test from "node:test";
import assert from "node:assert/strict";
import { util } from "fabric";
import { Resvg } from "@resvg/resvg-js";
import { markerPoints } from "../../src/figure/svg-marker-points";

const points = (path: string) => markerPoints(util.makePathSimpler(util.parsePath(path)));
const closeAngle = (actual: number, expected: number) => assert.ok(Math.abs(Math.sin(actual - expected)) < 1e-10 && Math.cos(actual - expected) > .999999, `${actual} != ${expected}`);

test("line vertices use incoming/outgoing angular bisectors across the angle wrap", () => {
  const markers = points("M0 0 L10 0 L10 10 L0 10");
  assert.deepEqual(markers.map(({ side, x, y }) => ({ side, x, y })), [
    { side: "start", x: 0, y: 0 }, { side: "mid", x: 10, y: 0 }, { side: "mid", x: 10, y: 10 }, { side: "end", x: 0, y: 10 },
  ]);
  [0, Math.PI / 4, Math.PI * .75, Math.PI].forEach((angle, i) => closeAngle(markers[i].angle, angle));
  closeAngle(points("M10 -1 L0 0 L-10 -1")[1].angle, Math.PI);
});

test("cubic and quadratic endpoint tangents skip coincident control points", () => {
  const cubic = points("M0 0 C0 0 0 10 10 10 C20 10 20 20 20 20");
  closeAngle(cubic[0].angle, Math.PI / 2);
  closeAngle(cubic[1].angle, 0);
  closeAngle(cubic[2].angle, Math.PI / 2);
  const quadratic = points("M0 0 Q0 0 20 0 Q20 20 20 20");
  closeAngle(quadratic[0].angle, 0);
  closeAngle(quadratic[1].angle, Math.PI / 4);
  closeAngle(quadratic[2].angle, Math.PI / 2);
});

test("multiple subpaths keep one overall start/end and preserve closed duplicate vertices", () => {
  const markers = points("M0 0L10 0L10 10Z M30 0L40 0L40 10Z");
  assert.equal(markers.length, 8);
  assert.deepEqual(markers.map(p => p.side), ["start", "mid", "mid", "mid", "mid", "mid", "mid", "end"]);
  for (const i of [0, 3, 4, 7]) closeAngle(markers[i].angle, -Math.PI * 3 / 8);
  const open = points("M0 0L0 10 M20 20L30 20");
  [Math.PI / 2, Math.PI / 2, 0, 0].forEach((angle, i) => closeAngle(open[i].angle, angle));
});

test("zero-length segments preserve markers and borrow nearby nonzero directions", () => {
  const markers = points("M0 0L0 0L0 10L0 10");
  assert.equal(markers.length, 4);
  markers.forEach(p => closeAngle(p.angle, Math.PI / 2));
  points("M5 7C5 7 5 7 5 7Q5 7 5 7Z").forEach(p => closeAngle(p.angle, 0));
  assert.deepEqual(points("M3 4"), [{ side: "start", x: 3, y: 4, angle: 0 }, { side: "end", x: 3, y: 4, angle: 0 }]);
  assert.deepEqual(points(""), []);
});

test("expanded markers match SVG auto-orientation for open curves and turns", () => {
  // resvg does not bisect closed-subpath start/end markers, so the closed
  // cases above assert the SVG specification directly rather than using it
  // as an oracle for that known renderer difference.
  for (const path of ["M20 30L50 30L50 60", "M20 30C25 35 40 50 50 50Q60 50 60 70", "M20 30L50 30L20 30"]) {
    const glyph = '<path d="M0 -2L7 0L0 2Z" fill="red"/>';
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="90"><defs><marker id="arrow" orient="auto" markerUnits="userSpaceOnUse" overflow="visible">${glyph}</marker></defs><path d="${path}" fill="none" stroke="black" stroke-width=".2" marker-start="url(#arrow)" marker-mid="url(#arrow)" marker-end="url(#arrow)"/></svg>`;
    const expanded = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="90"><path d="${path}" fill="none" stroke="black" stroke-width=".2"/>${points(path).map(p => `<g transform="translate(${p.x} ${p.y}) rotate(${p.angle * 180 / Math.PI})">${glyph}</g>`).join("")}</svg>`;
    const expected = new Resvg(source).render().pixels, actual = new Resvg(expanded).render().pixels;
    let difference = 0;
    for (let i = 0; i < actual.length; i++) difference += Math.abs(actual[i] - expected[i]);
    assert.ok(difference / actual.length < .05, `marker raster mismatch for ${path}: ${difference / actual.length}`);
  }
});

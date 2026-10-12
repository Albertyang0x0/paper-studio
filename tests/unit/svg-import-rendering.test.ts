import test from "node:test";
import assert from "node:assert/strict";
import { Group, IText, Path, Point, Rect, setEnv, util } from "fabric";
import { createCanvas } from "@napi-rs/canvas";
import { Resvg } from "@resvg/resvg-js";
import { primitiveSvg, sceneSvg } from "../../shared/svg";
import type { FigureScene, Primitive, StyleTokens } from "../../shared/types";
import { alignSvgModuleFrame, fabricPrimitive, svgPrimitiveEdit } from "../../src/figure/CanvasEditor";
import type { SvgCanvasResources } from "../../src/figure/svg-canvas";
import { svgUnderlineKey, svgUnderlineMetrics, svgUnderlineProbe } from "../../src/figure/svg-text-decoration";

const style: StyleTokens = {
  font: "Arial", ink: "#000000", muted: "#777777", accent: "#0000ff",
  palette: ["#0000ff"], lineWidth: 1, bodySize: 16, titleSize: 24,
  illustrationStyle: "SVG import",
};

test("imported fill and stroke rules survive both native canvas and SVG output", () => {
  const primitive: Primitive = {
    id: "compound", type: "path", x: 0, y: 0,
    path: "M0 0H40V40H0Z M10 10H30V30H10Z",
    fill: "#ff0000", stroke: "#000000", strokeWidth: 2,
    fillRule: "evenodd", strokeLineCap: "square", strokeLineJoin: "bevel",
    strokeMiterLimit: 9, strokeDashOffset: -3, dash: [6, 2],
  };
  const object = fabricPrimitive(primitive, style);
  assert.equal(object.fillRule, "evenodd");
  assert.equal(object.strokeLineCap, "square");
  assert.equal(object.strokeLineJoin, "bevel");
  assert.equal(object.strokeMiterLimit, 9);
  assert.equal(object.strokeDashOffset, -3);
  assert.deepEqual(object.strokeDashArray, [6, 2]);
  const svg = primitiveSvg(primitive, style);
  for (const attribute of ['fill-rule="evenodd"', 'stroke-linecap="square"',
    'stroke-linejoin="bevel"', 'stroke-miterlimit="9"', 'stroke-dashoffset="-3"']) {
    assert.ok(svg.includes(attribute), attribute);
  }
  assert.equal((svg.match(/stroke-linecap=/g) ?? []).length, 1);
  assert.equal((svg.match(/stroke-linejoin=/g) ?? []).length, 1);
  const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">${svg}</svg>`).render().pixels;
  assert.equal(pixels[(20 * 50 + 20) * 4 + 3], 0, "the compound path retains its transparent hole");
  assert.equal(pixels[(5 * 50 + 5) * 4 + 3], 255);
});

test("explicit SVG butt caps and zero dash offsets are retained", () => {
  const svg = primitiveSvg({
    id: "line", type: "line", x: 2, y: 3, width: 20, height: 0,
    stroke: "black", strokeLineCap: "butt", strokeDashOffset: 0,
  }, style);
  assert.match(svg, /stroke-linecap="butt"/);
  assert.match(svg, /stroke-dashoffset="0"/);
  assert.doesNotMatch(svg, /stroke-linecap="round"/);
  assert.match(primitiveSvg({ id: "legacy", type: "path", x: 0, y: 0, path: "M0 0L10 10" }, style), /stroke-linecap="round"/);
});

test("SVG group opacity composites overlapping children once and preserves nested transforms", () => {
  const primitive: Primitive = {
    id: "outer", type: "group", x: 10, y: 5, scaleX: 2, scaleY: 2, opacity: 0.5,
    children: [{
      id: "inner", type: "group", x: 5, y: 5,
      children: [
        { id: "one", type: "rect", x: 0, y: 0, width: 10, height: 10, fill: "#ff0000", strokeWidth: 0 },
        { id: "two", type: "rect", x: 5, y: 0, width: 10, height: 10, fill: "#0000ff", strokeWidth: 0 },
      ],
    }],
  };
  const svg = primitiveSvg(primitive, style);
  const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="50">${svg}</svg>`).render().pixels;
  const pixel = (x: number, y: number) => [...pixels.slice((y * 60 + x) * 4, (y * 60 + x) * 4 + 4)];
  assert.deepEqual(pixel(5, 5), [0, 0, 0, 0]);
  // resvg exposes premultiplied RGBA bytes.
  assert.deepEqual(pixel(25, 20), [128, 0, 0, 128]);
  assert.deepEqual(pixel(35, 20), [0, 0, 128, 128]);
});

test("SVG module frame stays fixed when edited paths extend beyond the frame", () => {
  const frame = new Rect({ left: 0, top: 0, width: 100, height: 80, strokeWidth: 0 });
  const path = new Path("M-20 -10H40V30H-20Z", { strokeWidth: 0 });
  const group = new Group([frame, path], { left: 200, top: 100, scaleX: 2, scaleY: 3 });
  const offset = alignSvgModuleFrame(group, frame, { x: 200, y: 100 });
  assert.equal(frame.getXY().x, 200);
  assert.equal(frame.getXY().y, 100);
  assert.equal(path.getXY().x, 160);
  assert.equal(path.getXY().y, 70);
  group.set({ left: group.left + 15, top: group.top - 10, scaleX: 4, scaleY: 6 });
  const saved = { x: group.left + offset.x * group.scaleX, y: group.top + offset.y * group.scaleY };
  assert.equal(saved.x, frame.getXY().x);
  assert.equal(saved.y, frame.getXY().y);
  const restoredFrame = new Rect({ left: 0, top: 0, width: 100, height: 80, strokeWidth: 0 });
  const restored = new Group([restoredFrame, new Path("M-20 -10H40V30H-20Z", { strokeWidth: 0 })], {
    left: saved.x, top: saved.y, scaleX: group.scaleX, scaleY: group.scaleY,
  });
  alignSvgModuleFrame(restored, restoredFrame, saved);
  assert.equal(restoredFrame.getXY().x, saved.x);
  assert.equal(restoredFrame.getXY().y, saved.y);
  assert.equal(restored.left, group.left);
  assert.equal(restored.top, group.top);
});

test("imported shape geometry keeps the SVG origin with thick strokes and transforms", () => {
  for (const type of ["rect", "ellipse"] as const) {
    const primitive: Primitive = {
      id: type, type, x: 100, y: 50, width: 40, height: 20,
      stroke: "black", strokeWidth: 8, rotation: 30, scaleX: 2, scaleY: 3,
    };
    const object = fabricPrimitive(primitive, style, true);
    const geometryOrigin = util.transformPoint(new Point(-object.width / 2, -object.height / 2), object.calcTransformMatrix());
    assert.ok(Math.abs(geometryOrigin.x - primitive.x) < 1e-8, `${type} x`);
    assert.ok(Math.abs(geometryOrigin.y - primitive.y) < 1e-8, `${type} y`);
    const legacy = fabricPrimitive(primitive, style);
    assert.equal(legacy.left, primitive.x, "generated figures retain their existing coordinate convention");
    assert.equal(legacy.top, primitive.y);
  }
});

test("imported rotated paths transform their geometric origin once", () => {
  const primitive: Primitive = {
    id: "rotated-path", type: "path", x: 100, y: 50,
    path: "M10 20H30V40H10Z", fill: "red", stroke: "black", strokeWidth: 8,
    rotation: 90, scaleX: 2, scaleY: 3,
  };
  const object = fabricPrimitive(primitive, style, true) as Path;
  const firstPoint = util.transformPoint(new Point(10, 20).subtract(object.pathOffset), object.calcTransformMatrix());
  assert.ok(Math.abs(firstPoint.x - 40) < 1e-8);
  assert.ok(Math.abs(firstPoint.y - 70) < 1e-8);
  // The editor stores translation separately from the offset of the ink bounds.
  // Verify that a changed rotation/scale can be persisted without an origin jump.
  const previousOffset = { x: object.left - primitive.x, y: object.top - primitive.y };
  const modified: Primitive = { ...primitive, rotation: 35, scaleX: 4, scaleY: 1.5 };
  const local = fabricPrimitive({ ...modified, x: 0, y: 0 }, style, true);
  modified.x += previousOffset.x - local.left;
  modified.y += previousOffset.y - local.top;
  const restored = fabricPrimitive(modified, style, true);
  assert.ok(Math.abs(restored.left - object.left) < 1e-8);
  assert.ok(Math.abs(restored.top - object.top) < 1e-8);
});

test("imported SVG text remains literal through scene export and nested groups", () => {
  const text: Primitive = { id: "literal", type: "text", x: 0, y: 0, text: "$5$ x_1 & <" };
  const scene: FigureScene = {
    schema: "paper-atelier/1", id: "literal-svg", title: "Literal SVG", figureType: "svg-import",
    width: 100, height: 100, style, regions: [], modules: [], connectors: [],
    annotations: [{ id: "nested", type: "group", x: 0, y: 0, children: [text] }],
  };
  assert.match(sceneSvg(scene, false), /\$5\$ x_1 &amp; &lt;/);
  assert.doesNotMatch(sceneSvg(scene, false), /x₁/);
  assert.match(primitiveSvg(text, style), /5 x₁ &amp; &lt;/, "generated text retains math typography");
});

const closePoint = (actual: Point, expected: Point) => {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-7, `x ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-7, `y ${actual.y} != ${expected.y}`);
};

test("mirrored image geometry follows the SVG local origin and keeps logical dimensions", () => {
  const resources: SvgCanvasResources = {
    images: new Map([["image", { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement]]), shadows: new Map(),
  };
  const primitive: Primitive = { id: "image", type: "image", assetId: "image", x: 120, y: 80, width: 40, height: 30, rotation: 90, scaleX: 2, scaleY: -3 };
  const object = fabricPrimitive(primitive, style, true, resources);
  assert.equal(object.width, 40);
  assert.equal(object.height, 30);
  const matrix = object.calcTransformMatrix();
  closePoint(util.transformPoint(new Point(-20, -15), matrix), new Point(120, 80));
  closePoint(util.transformPoint(new Point(20, 15), matrix), new Point(210, 160));
});

test("nested native edits survive redraw under rotated and scaled SVG parents", () => {
  const child: Primitive = { id: "child", type: "path", x: 20, y: 15, path: "M-4 -8H36V12H-4Z", fill: "red", strokeWidth: 4, rotation: 20 };
  const parent: Primitive = { id: "parent", type: "group", x: 60, y: 45, rotation: 30, scaleX: 2, scaleY: 1.5, opacity: .6, children: [child] };
  let offset: { x: number; y: number } | undefined;
  const group = fabricPrimitive(parent, style, true, undefined, (object, primitive) => {
    if (primitive.id === child.id) offset = { x: object.left - child.x, y: object.top - child.y };
  }) as Group;
  const object = group.item(0) as Path;
  const before = { startLeft: object.left, startTop: object.top, baseScaleX: object.scaleX, baseScaleY: object.scaleY,
    baseFlipX: object.flipX, baseFlipY: object.flipY, svgPrimitiveOffset: offset };
  object.set({ left: object.left + 18, top: object.top - 7, angle: 65, scaleX: 1.4, scaleY: -.75 });
  // The real Fabric event must not recenter the parent before persistence.
  object.fire("modified", { target: object });
  const matrix = object.calcTransformMatrix();
  const expected = [-4, 36].flatMap(x => [-8, 12].map(y => util.transformPoint(new Point(x, y).subtract(object.pathOffset), matrix)));
  const updated = svgPrimitiveEdit(child, object, before, style);
  const restored = fabricPrimitive({ ...parent, children: [updated] }, style, true) as Group;
  const saved = restored.item(0) as Path;
  const actual = [-4, 36].flatMap(x => [-8, 12].map(y => util.transformPoint(new Point(x, y).subtract(saved.pathOffset), saved.calcTransformMatrix())));
  actual.forEach((point, index) => closePoint(point, expected[index]));
  assert.equal(restored.opacity, .6);
  assert.equal(updated.type, "path");
  assert.equal(updated.path, child.path);
});

test("native canvas intersects local clips and composites overlapping group opacity once", () => {
  setEnv({ document: { createElement: () => createCanvas(1, 1) }, window: { devicePixelRatio: 1 }, dispose: () => undefined } as any);
  const canvas = createCanvas(120, 100);
  const context = canvas.getContext("2d");
  const primitive: Primitive = {
    id: "clipped", type: "group", x: 10, y: 10, opacity: .5, rotation: 0,
    clip: [{ path: "M0 0H70V60H0Z" }, { path: "M20 10H80V50H20Z" }],
    children: [
      { id: "red", type: "rect", x: 0, y: 0, width: 80, height: 60, fill: "red", strokeWidth: 0 },
      { id: "blue", type: "rect", x: 40, y: 0, width: 40, height: 60, fill: "blue", strokeWidth: 0 },
    ],
  };
  const object = fabricPrimitive(primitive, style, true);
  object.render(context as unknown as CanvasRenderingContext2D);
  const rgba = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
  assert.deepEqual(rgba(20, 40), [0, 0, 0, 0], "outside second clip");
  assert.deepEqual(rgba(85, 40), [0, 0, 0, 0], "outside first clip");
  assert.deepEqual(rgba(40, 40), [255, 0, 0, 128]);
  assert.deepEqual(rgba(65, 40), [0, 0, 255, 128], "overlap receives group opacity once");
  object.dispose();
});

test("a filtered group paints only its local effect and retains editable source children", () => {
  setEnv({ document: { createElement: () => createCanvas(1, 1) }, window: { devicePixelRatio: 1 }, dispose: () => undefined } as any);
  const effect = createCanvas(20, 10);
  effect.getContext("2d").fillStyle = "green";
  effect.getContext("2d").fillRect(0, 0, 20, 10);
  const region = { x: -5, y: -3, width: 20, height: 10 };
  const source: Primitive = { id: "source", type: "rect", x: 0, y: 0, width: 30, height: 20, fill: "blue", strokeWidth: 0 };
  const primitive: Primitive = { id: "effect", type: "group", x: 30, y: 30, children: [source],
    svgShadow: { dx: 3, dy: 3, spread: .75, color: "green", knockout: true, region } };
  const resources: SvgCanvasResources = { images: new Map(), shadows: new Map([[primitive.id, { image: effect as unknown as HTMLImageElement, box: region }]]) };
  const visited: string[] = [];
  const group = fabricPrimitive(primitive, style, true, resources, (_, p) => visited.push(p.id)) as Group;
  assert.deepEqual(visited, [source.id, primitive.id]);
  assert.ok(group.getObjects().some(object => object instanceof Rect && object.width === 30));
  assert.equal(group.interactive, true);
  const output = createCanvas(100, 80);
  group.render(output.getContext("2d") as unknown as CanvasRenderingContext2D);
  const pixel = (x: number, y: number) => [...output.getContext("2d").getImageData(x, y, 1, 1).data];
  assert.deepEqual(pixel(27, 29), [0, 128, 0, 255]);
  assert.deepEqual(pixel(50, 40), [0, 0, 0, 0], "SourceGraphic remains excluded from the effect output");
  group.dispose();
});

test("stroke-first paint order preserves the fill interior on canvas and SVG export", () => {
  setEnv({ document: { createElement: () => createCanvas(1, 1) }, window: { devicePixelRatio: 1 }, dispose: () => undefined } as any);
  const primitive: Primitive = { id: "paint-order", type: "rect", x: 10, y: 10,
    width: 30, height: 25, fill: "red", stroke: "blue", strokeWidth: 8, paintOrder: "stroke fill" };
  const object = fabricPrimitive(primitive, style, true);
  const output = createCanvas(60, 50);
  object.render(output.getContext("2d") as unknown as CanvasRenderingContext2D);
  const pixel = (x: number, y: number) => [...output.getContext("2d").getImageData(x, y, 1, 1).data];
  assert.deepEqual(pixel(12, 20), [255, 0, 0, 255], "fill covers the inside half of the stroke");
  assert.deepEqual(pixel(8, 20), [0, 0, 255, 255], "outer stroke stays visible");
  const exported = primitiveSvg(primitive, style);
  assert.match(exported, /paint-order="stroke fill"/);
  const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="50">${exported}</svg>`).render().pixels;
  assert.deepEqual([...pixels.slice((20 * 60 + 12) * 4, (20 * 60 + 12) * 4 + 4)], [255, 0, 0, 255]);
  assert.equal(fabricPrimitive({ ...primitive, paintOrder: undefined }, style, true).paintFirst, "fill", "existing scenes retain fill-first behavior");
  assert.equal(object.strokeWidth, primitive.strokeWidth);
});

test("letter spacing uses local SVG units and keeps the full font fallback list", () => {
  setEnv({ document: { createElement: () => createCanvas(1, 1) }, window: { devicePixelRatio: 1 }, dispose: () => undefined } as any);
  const family = '-apple-system, "Segoe UI", Arial, sans-serif';
  const primitive: Primitive = { id: "spacing", type: "text", x: 15, y: 20, text: "ABC",
    fontSize: 20, fontFamily: family, letterSpacing: 2.5, scaleX: 1.4, strokeWidth: 0 };
  const spaced = fabricPrimitive(primitive, style, true) as IText;
  const unspaced = fabricPrimitive({ ...primitive, letterSpacing: 0 }, style, true) as IText;
  assert.equal(spaced.fontFamily, family);
  assert.ok(spaced._getFontDeclaration().endsWith(family));
  assert.ok(Math.abs(spaced.width - unspaced.width - 5) < 1e-7, "two character gaps each add 2.5 local pixels");
  assert.equal(spaced.charSpacing, 125);
  const svg = primitiveSvg(primitive, style, true);
  assert.match(svg, /letter-spacing="2.5"/);
  assert.match(svg, /font-family="-apple-system, &quot;Segoe UI&quot;, Arial, sans-serif"/);
  assert.match(primitiveSvg({ ...primitive, letterSpacing: 0 }, style, true), /letter-spacing="0"/);
});

test("SVG text uses the native baseline even when an invisible stroke adds Fabric bounds", () => {
  setEnv({ document: { createElement: () => createCanvas(1, 1) }, window: { devicePixelRatio: 1 }, dispose: () => undefined } as any);
  const primitive: Primitive = { id: "text-origin", type: "text", x: 20, y: 10,
    text: "Linear spacing", fontSize: 24, fontFamily: "Arial", fill: "black", stroke: "none" };
  const reference = createCanvas(240, 70);
  const context = reference.getContext("2d");
  context.font = 'normal 400 24px "Arial"';
  context.fillText(primitive.text!, primitive.x, primitive.y + .92 * primitive.fontSize!);
  const expected = context.getImageData(0, 0, 240, 70).data;
  // Fabric includes strokeWidth in origin dimensions even for stroke:none.
  // Every case must paint at the SVG position rather than move by half a stroke.
  for (const strokeWidth of [undefined, 1, 6]) {
    const object = fabricPrimitive({ ...primitive, strokeWidth }, style, true) as IText;
    const output = createCanvas(240, 70);
    object.render(output.getContext("2d") as unknown as CanvasRenderingContext2D);
    assert.deepEqual(output.getContext("2d").getImageData(0, 0, 240, 70).data, expected, `strokeWidth=${strokeWidth}`);
    object.dispose();
  }
  const transformed = { ...primitive, strokeWidth: 8, rotation: 32, scaleX: -1.5, scaleY: 2 };
  const object = fabricPrimitive(transformed, style, true);
  const origin = util.transformPoint(new Point(-object.width / 2, -object.height / 2), object.calcTransformMatrix());
  closePoint(origin, new Point(primitive.x, primitive.y));
  const legacy = fabricPrimitive(primitive, style);
  assert.equal(legacy.left, primitive.x, "generated figures keep their existing origins");
  assert.equal(legacy.top, primitive.y);
});

test("underlined SVG text paints a native decoration and retains it after editing and JSON reload", () => {
  setEnv({ document: { createElement: () => createCanvas(1, 1) }, window: { devicePixelRatio: 1 }, dispose: () => undefined } as any);
  const primitive: Primitive = { id: "underlined", type: "text", x: 20, y: 10,
    text: "ABC", fontSize: 30, fontFamily: "Arial", fill: "#123456", strokeWidth: 0, underline: true };
  const nativePixels = (value: Primitive) => {
    const output = createCanvas(260, 70);
    const object = fabricPrimitive(value, style, true);
    object.render(output.getContext("2d") as unknown as CanvasRenderingContext2D);
    object.dispose();
    return output.getContext("2d").getImageData(0, 0, 260, 70).data;
  };
  const underlineExtent = (decorated: ArrayLike<number>, plain: ArrayLike<number>) => {
    const baseline = primitive.y + .92 * primitive.fontSize!;
    const xs: number[] = [];
    for (let y = 0; y < 70; y++) for (let x = 0; x < 260; x++) {
      const alpha = (y * 260 + x) * 4 + 3;
      if (decorated[alpha] > plain[alpha]) {
        assert.ok(y >= Math.floor(baseline), "the added ink is beneath the glyph baseline");
        xs.push(x);
      }
    }
    assert.ok(xs.length > 20, "the decoration must paint visible ink");
    return Math.max(...xs) - Math.min(...xs);
  };
  const initialExtent = underlineExtent(nativePixels(primitive), nativePixels({ ...primitive, underline: false }));
  const object = fabricPrimitive(primitive, style, true) as IText;
  assert.equal(object.underline, true);
  object.set("text", "ABCDEF");
  const edited = svgPrimitiveEdit(primitive, object, {}, style);
  const restored: Primitive = JSON.parse(JSON.stringify(edited));
  assert.equal(restored.text, "ABCDEF");
  assert.equal(restored.underline, true);
  const editedExtent = underlineExtent(nativePixels(restored), nativePixels({ ...restored, underline: false }));
  assert.ok(editedExtent > initialExtent * 1.5, "the native underline follows the edited text width");
  object.dispose();

  const exported = primitiveSvg(restored, style, true);
  assert.match(exported, /text-decoration="underline"/);
  const svgPixels = (value: Primitive) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="70">${primitiveSvg(value, style, true)}</svg>`).render().pixels;
  underlineExtent(svgPixels(restored), svgPixels({ ...restored, underline: false }));
  assert.doesNotMatch(primitiveSvg({ ...primitive, underline: undefined }, style, true), /text-decoration=/,
    "legacy text retains its appearance");
});

test("native SVG underline uses measured font metrics instead of Fabric's fixed line position", () => {
  setEnv({ document: { createElement: () => createCanvas(1, 1) }, window: { devicePixelRatio: 1 }, dispose: () => undefined } as any);
  // Keep this cross-rasterizer comparison on the probe's integer baseline grid.
  const text: Primitive = { id: "metrics", type: "text", x: 10, y: 40 - .92 * 24, text: "      ",
    fontFamily: "Arial", fontSize: 24, fill: "black", strokeWidth: 0, underline: true };
  const probe = svgUnderlineProbe(text, style);
  const decoded = decodeURIComponent(probe.source.slice(probe.source.indexOf(",") + 1));
  const rendered = new Resvg(decoded).render();
  const metrics = svgUnderlineMetrics(rendered.pixels, probe.width, probe.height, probe);
  const resources: SvgCanvasResources = { images: new Map(), shadows: new Map(),
    underlines: new Map([[svgUnderlineKey(text, style), metrics]]) };
  const object = fabricPrimitive(text, style, true, resources) as IText;
  const output = createCanvas(100, 65), context = output.getContext("2d");
  object.render(context as unknown as CanvasRenderingContext2D);
  const expected = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="65">${primitiveSvg(text, style, true)}</svg>`).render().pixels;
  const actual = context.getImageData(0, 0, 100, 65).data;
  let error = 0;
  for (let y = 0; y < 65; y++) error += Math.abs(actual[(y * 100 + 15) * 4 + 3] - expected[(y * 100 + 15) * 4 + 3]);
  // Resvg and native Canvas quantize antialiased edge coverage differently.
  // Across the two edge rows, less than 0.1 pixel of alpha difference is allowed.
  assert.ok(error <= 24, `measured underline must match the source SVG row coverage (error ${error})`);
  assert.equal(object.underline, true, "text stays native and editable");
  object.dispose();
  const giant = svgUnderlineProbe({ ...text, fontSize: 10000 }, style);
  assert.ok(giant.width * giant.height <= 100_000, "oversized fonts cannot allocate oversized calibration images");
});

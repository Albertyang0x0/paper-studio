import test from "node:test";
import assert from "node:assert/strict";
import {
  sceneSvg,
  orthogonalRoute,
  patchPrimitive,
  allPrimitives,
  shouldRenderConnectorLabel,
} from "../../shared/svg";
import {
  normalizeElements,
  validateSemantic,
  validateDesign,
  structuralIssues,
} from "../../server/validation";
import { expandPrimitive } from "../../shared/assets";
import { pngForScene } from "../../server/pipeline";
import { renderedBounds } from "../../server/bounds";
import { fitModuleText } from "../../server/text-layout";
import { preserveLockedObjects } from "../../shared/locks";
import { displayMath } from "../../shared/math-text";
import { canvasPaint } from "../../shared/canvas-paint";
import { textBoxes, textCollisions } from "../../server/typography";
import { validatePlanningCheckpoint } from "../../server/checkpoints";
import { settleGlobalLayout } from "../../server/layout";
import type {
  FigureScene,
  SceneModule,
  Primitive,
  RunInput,
} from "../../shared/types";

const elements: Primitive[] = [
  {
    id: "box",
    type: "rect",
    x: 0,
    y: 0,
    width: 160,
    height: 80,
    fill: "#eef3fa",
    stroke: "#234",
    strokeWidth: 2,
  },
  {
    id: "label",
    type: "text",
    x: 10,
    y: 15,
    width: 140,
    text: "Model & data",
    fontSize: 24,
  },
  {
    id: "icon",
    type: "symbol",
    symbol: "database",
    x: 30,
    y: 100,
    width: 60,
    height: 60,
  },
];
test("SVG none paint stays unpainted on the native canvas", () => {
  assert.equal(canvasPaint("none"), "");
  assert.equal(canvasPaint(" None ", "#000"), "");
  assert.equal(canvasPaint(undefined, "#345"), "#345");
  assert.equal(canvasPaint(undefined), undefined);
  assert.equal(canvasPaint("transparent"), "transparent");
  assert.equal(canvasPaint("#abc"), "#abc");
});
test("typography checks measure glyph collisions and include nested transforms", () => {
  const text: Primitive = {
    id: "first-text",
    type: "text",
    x: 0,
    y: 0,
    text: "Model",
    fontSize: 24,
  };
  const box = textBoxes([text], scene.style)[0];
  assert.ok(box.width > 35 && box.height > 10);
  assert.equal(
    textCollisions([text, { ...text, id: "collision", x: 5 }], scene.style)
      .length,
    1,
  );
  assert.equal(
    textCollisions([text, { ...text, id: "clear", x: 200 }], scene.style)
      .length,
    0,
  );
  const child = textBoxes(
    [
      {
        id: "frame",
        type: "group",
        x: 100,
        y: 50,
        scaleX: 0.5,
        scaleY: 0.5,
        children: [text],
      },
    ],
    scene.style,
  )[0];
  assert.equal(child.effectiveFontSize, 12);
  assert.ok(Math.abs(child.x - (100 + box.x * 0.5)) < 0.01);
  const colliding = {
    ...scene,
    modules: [
      { ...scene.modules[0], elements: [text, { ...text, id: "other", x: 5 }] },
    ],
  };
  assert.ok(
    structuralIssues(colliding).some((i) =>
      i.message.includes("glyph collision"),
    ),
  );
  assert.deepEqual(structuralIssues(colliding, false), []);
});
const module = (id: string, x: number, y: number): SceneModule => ({
  id,
  title: id,
  role: "structure",
  brief: "Test only",
  componentIds: [id],
  labels: ["Model & data"],
  sourceRefs: ["source.md"],
  x,
  y,
  width: 200,
  height: 200,
  contentWidth: 200,
  contentHeight: 200,
  ports: [],
  elements: elements.map((e) => expandPrimitive({ ...e, id: id + "-" + e.id })),
  method: "vector-agent",
  status: "ready",
});
const scene: FigureScene = {
  schema: "paper-atelier/1",
  id: "fixture",
  title: "Schema test (not a generated result)",
  width: 1000,
  height: 600,
  style: {
    font: "Arial",
    ink: "#123",
    muted: "#789",
    accent: "#356dcc",
    palette: ["#eef3fa"],
    lineWidth: 2,
    bodySize: 24,
    titleSize: 28,
    illustrationStyle: "vector",
  },
  regions: [],
  modules: [
    module("first", 30, 200),
    module("obstacle", 390, 200),
    module("last", 740, 200),
  ],
  connectors: [{ id: "flow", from: "first", to: "last", label: "connect" }],
  annotations: [],
};

test("SVG is a native vector document, not an image wrapper", () => {
  const svg = sceneSvg(scene);
  assert.match(svg, /<text/);
  assert.match(svg, /Model &amp; data/);
  assert.match(svg, /<path/);
  assert.doesNotMatch(svg, /<image|data:image|foreignObject|script/);
  assert.match(svg, /paper-atelier\/1/);
  assert.match(svg, /data-module-id="first"/);
  assert.ok(pngForScene(scene).length > 1000);
});
test("symbols expand into individually addressable vector objects", () => {
  const symbol = expandPrimitive(elements[2]);
  assert.equal(symbol.type, "group");
  assert.ok(allPrimitives([symbol]).length > 5);
  assert.ok(allPrimitives([symbol]).every((e) => e.type !== "symbol"));
  assert.equal(
    new Set(allPrimitives([symbol]).map((e) => e.id)).size,
    allPrimitives([symbol]).length,
  );
});
test("edits preserve unrelated objects and module contents", () => {
  const copy = structuredClone(scene),
    before = JSON.stringify(copy.modules.slice(1));
  copy.modules[0].elements = patchPrimitive(
    copy.modules[0].elements,
    "first-label",
    { text: "Edited" },
  );
  assert.equal(JSON.stringify(copy.modules.slice(1)), before);
  assert.match(sceneSvg(copy), />Edited</);
  assert.equal(
    allPrimitives(scene.modules[0].elements).find((e) => e.id === "first-label")
      ?.text,
    "Model & data",
  );
});
test("orthogonal routing avoids intervening module", () => {
  const points = orthogonalRoute(
    { x: 230, y: 300 },
    { x: 740, y: 300 },
    [{ x: 390, y: 200, width: 200, height: 200 }],
    scene,
  );
  assert.ok(points.length > 2);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    assert.ok(a.x === b.x || a.y === b.y);
    const hits =
      a.y === b.y
        ? a.y > 200 &&
          a.y < 400 &&
          Math.max(a.x, b.x) > 390 &&
          Math.min(a.x, b.x) < 590
        : a.x > 390 &&
          a.x < 590 &&
          Math.max(a.y, b.y) > 200 &&
          Math.min(a.y, b.y) < 400;
    assert.equal(hits, false);
  }
});
test("structural checks flag genuine collisions without numeric quality scores", () => {
  const copy = structuredClone(scene);
  copy.modules[1].x = 50;
  assert.ok(structuralIssues(copy).some((i) => i.severity === "high"));
  assert.equal(structuralIssues(scene).length, 0);
});
test("specialists must preserve required editable labels", () => {
  assert.doesNotThrow(() => normalizeElements(elements, scene.modules[0]));
  assert.throws(() =>
    normalizeElements(
      elements.filter((e) => e.type !== "text"),
      scene.modules[0],
    ),
  );
  assert.throws(
    () =>
      normalizeElements(
        elements.map((e) => (e.type === "text" ? { ...e, text: "wrong" } : e)),
        scene.modules[0],
      ),
    /omitted/,
  );
  assert.throws(
    () =>
      normalizeElements(
        elements.map((e) => ({ ...e, x: NaN })),
        scene.modules[0],
      ),
    /Non-finite/,
  );
});
test("science plan cannot cite an unknown file or omit a component", () => {
  const semantic = {
    title: "Test",
    message: "Test",
    components: [
      { id: "one", label: "one", meaning: "one", sourceRefs: ["source.md"] },
      { id: "two", label: "two", meaning: "two", sourceRefs: ["source.md"] },
    ],
    relationships: [{ from: "one", to: "two", meaning: "flow" }],
    constraints: [],
  };
  assert.doesNotThrow(() => validateSemantic(semantic, new Set(["source.md"])));
  assert.throws(() => validateSemantic(semantic, new Set(["different.md"])));
  assert.throws(
    () =>
      validateDesign(
        {
          ...scene,
          rationale: "Test",
          modules: scene.modules.map((m) => ({ ...m, componentIds: ["one"] })),
        } as any,
        semantic,
      ),
    /omitted/,
  );
});
test("measured bounds detect text spilling out of its module", () => {
  const bounds = renderedBounds(
    [
      {
        id: "spill",
        type: "text",
        x: 175,
        y: 10,
        text: "This label does not fit",
        fontSize: 28,
      },
    ],
    200,
    100,
    scene.style,
  );
  assert.ok(bounds && bounds.right > 200);
});
test("long labels wrap with real font metrics without changing content", () => {
  const original = {
    id: "text",
    type: "text" as const,
    x: 10,
    y: 10,
    text: "Frozen Base Model and hidden states",
    fontSize: 24,
    width: 170,
  };
  const wrapped = fitModuleText([original], 200, 200, scene.style)[0];
  assert.ok(wrapped.text?.includes("\n"));
  assert.equal(wrapped.text?.replace(/\s+/g, " "), original.text);
  assert.equal(wrapped.fontSize, 24);
  assert.ok(renderedBounds([wrapped], 200, 200, scene.style)!.right < 200);
});

test('linked label containers grow without reducing type or mutating the checkpoint', () => {
  const items: Primitive[] = [
    { id: 'text_model_container', type: 'rect', x: 145, y: 415, width: 190, height: 80, fill: 'none', stroke: 'none' },
    { id: 'text_model', type: 'text', x: 0, y: 0, containerId: 'text_model_container',
      text: 'Frozen Base\nModel', fontSize: 31, fontFamily: 'Arial', fontWeight: 700, align: 'center' },
  ];
  const snapshot = structuredClone(items);
  const fitted = fitModuleText(items, 480, 500, { ...scene.style, minimumFontSize: 31 });
  const box = fitted[0], label = fitted[1];
  assert.deepEqual(items, snapshot);
  assert.ok(box.width! > 190 && box.height! >= 85);
  assert.equal(label.fontSize, 31);
  assert.equal(label.text, 'Frozen Base\nModel');
  assert.ok(box.y + box.height! <= 500);
  assert.ok(label.y >= box.y && label.y + 2 * 31 * 1.24 <= box.y + box.height!);
  assert.deepEqual(fitModuleText(fitted, 480, 500, scene.style), fitted);
});

test('container growth works before or after its label and inside translated groups', () => {
  const label: Primitive = { id: 'label', type: 'text', x: 0, y: 0, containerId: 'box',
    text: 'Earlier\nReasoning', fontSize: 31 };
  const box: Primitive = { id: 'box', type: 'rect', x: 20, y: 10, width: 100, height: 40 };
  const fitted = fitModuleText([{ id: 'group', type: 'group', x: 30, y: 20,
    children: [label, box] }], 480, 500, scene.style);
  const [text, container] = fitted[0].children!;
  assert.ok(container.height! >= 85 && container.width! > 100);
  assert.equal(text.text, label.text);
  assert.equal(text.fontSize, 31);
});

test('locked containers and impossible labels remain explicit layout failures', () => {
  const box: Primitive = { id: 'box', type: 'rect', x: 0, y: 0, width: 100, height: 20 };
  const text: Primitive = { id: 'label', type: 'text', x: 0, y: 0, containerId: 'box',
    text: 'Frozen Base\nModel', fontSize: 31 };
  assert.throws(() => fitModuleText([{ ...box, locked: true }, text], 480, 500, scene.style), /locked container/);
  assert.throws(() => fitModuleText([box, text], 100, 30, scene.style), /cannot fit module/);
  assert.throws(() => fitModuleText([{ ...text, containerId: 'missing' }], 480, 500, scene.style), /Unknown label container/);
  const locked = { ...text, locked: true };
  assert.deepEqual(fitModuleText([box, locked], 480, 500, scene.style)[1], locked);
});
test("regeneration preserves locked text AND its ancestor geometry", () => {
  const leaf: Primitive = {
    id: "locked",
    type: "text",
    x: 5,
    y: 7,
    fontSize: 24,
    text: "Keep this",
    locked: true,
  };
  const old: Primitive[] = [
    {
      id: "parent",
      type: "group",
      x: 40,
      y: 50,
      scaleX: 0.8,
      scaleY: 0.8,
      children: [leaf],
    },
  ];
  const changed: Primitive[] = [
    {
      id: "parent",
      type: "group",
      x: 240,
      y: 150,
      scaleX: 0.3,
      children: [{ ...leaf, text: "Changed", x: 20 }],
    },
  ];
  const preserved = preserveLockedObjects(old, changed);
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].x, 40);
  assert.equal(preserved[0].scaleX, 0.8);
  assert.deepEqual(preserved[0].children?.[0], leaf);
  assert.equal(
    new Set(allPrimitives(preserved).map((e) => e.id)).size,
    allPrimitives(preserved).length,
  );
});
test("omitted locked groups are restored independently of model output", () => {
  const old: Primitive[] = [
    {
      id: "all-locked",
      type: "group",
      x: 50,
      y: 70,
      locked: true,
      children: elements,
    },
  ];
  const output = preserveLockedObjects(old, [
    { id: "new", type: "text", x: 0, y: 0, text: "new", fontSize: 24 },
  ]);
  assert.deepEqual(output[1], old[0]);
  assert.equal(output[0].id, "new");
});
test("one top-level group can contain a substantive editable module", () => {
  assert.doesNotThrow(() =>
    normalizeElements(
      [{ id: "group", type: "group", x: 0, y: 0, children: elements }],
      scene.modules[0],
    ),
  );
});
test("basic mathematical subscripts remain editable Unicode text", () => {
  assert.equal(displayMath("y_{t+1} and p_t"), "yₜ₊₁ and pₜ");
  assert.equal(displayMath("s_θ"), "s_θ");
  assert.match(
    sceneSvg({
      ...scene,
      annotations: [
        { id: "math", type: "text", x: 0, y: 0, text: "y_{t+1}", fontSize: 24 },
      ],
    }),
    /yₜ₊₁/,
  );
});
test("annotation aliases canonicalize into addressable vector objects", () => {
  const output = normalizeElements(
    [
      { type: "icon", icon: "graduation-cap", x: 10, y: 10, size: 40 },
      {
        type: "text",
        x: 20,
        y: 20,
        text: "Learned",
        size: 22,
        color: "#123456",
      },
    ],
    { id: "annotation", width: 200, height: 200, labels: [] },
    false,
  );
  assert.equal(output[0].type, "group");
  assert.equal(output[1].fontSize, 22);
  assert.equal(output[1].fill, "#123456");
  assert.ok(output.every((e) => e.id));
});
test("text aliases and typographic ellipses preserve editable scientific labels", () => {
  const elements = normalizeElements(
    [
      {
        id: "label",
        type: "text",
        x: 0,
        y: 0,
        content: "Risk > τ\n…\n···",
        fontSize: 24,
      },
    ],
    {
      id: "annotations",
      width: 200,
      height: 120,
      labels: ["Risk > τ?", "..."],
    },
    false,
  );
  assert.equal(elements[0].text, "Risk > τ\n…\n···");
});
test("planning checkpoints cannot be reused after evidence or intent changes", () => {
  const materials = [
    { id: "source", name: "source.md", content: "Model & data" },
  ];
  const semantic = {
    title: "Test",
    message: "Test",
    constraints: [],
    relationships: [],
    components: [
      {
        id: "first",
        label: "First",
        meaning: "Test",
        sourceRefs: ["source.md"],
      },
      {
        id: "second",
        label: "Second",
        meaning: "Test",
        sourceRefs: ["source.md"],
      },
    ],
  };
  const checkpoint = {
    materials,
    intent: "Overview",
    figureType: "method-overview",
    semanticPlan: semantic,
  };
  const input: RunInput = {
    ...checkpoint,
    references: [],
    config: {
      planner: "test",
      director: "test",
      worker: "test",
      assembler: "test",
      critic: "test",
      methods: {
        illustration: "vector-agent",
        structure: "vector-agent",
        plot: "vector-agent",
      },
      reviewRounds: 0,
    },
  };
  validatePlanningCheckpoint(checkpoint, input);
  assert.throws(
    () =>
      validatePlanningCheckpoint(checkpoint, {
        ...input,
        intent: "Different scope",
      }),
    /stale/,
  );
  assert.throws(
    () =>
      validatePlanningCheckpoint(checkpoint, {
        ...input,
        materials: [{ ...materials[0], content: "Different evidence" }],
      }),
    /stale/,
  );
});
test("global layout clears region headings without changing scientific contents", () => {
  const initial = {
    ...scene,
    regions: [
      {
        id: "panel",
        title: "Panel heading",
        x: 10,
        y: 10,
        width: 230,
        height: 310,
        fill: "#fff",
      },
    ],
    modules: [{ ...scene.modules[0], y: 20 }],
  };
  const settled = settleGlobalLayout(initial);
  assert.ok(settled.modules[0].y > initial.modules[0].y);
  assert.deepEqual(settled.modules[0].elements, initial.modules[0].elements);
  assert.deepEqual(settled.connectors, initial.connectors);
});

test('connector labels already owned by endpoint modules are drawn once without losing edge metadata',()=>{
  const s=structuredClone(scene);const edge={id:'edge',from:s.modules[0].id,to:'other',label:'Pause Generation'};
  s.modules[0].elements=[{id:'pause',type:'text',x:0,y:0,text:'Pause\nGeneration'}];
  assert.equal(shouldRenderConnectorLabel(edge,s),false);assert.equal(edge.label,'Pause Generation');
  edge.label='Accepted correction';assert.equal(shouldRenderConnectorLabel(edge,s),true);
  s.modules[0].elements=[{id:'a',type:'text',x:0,y:0,text:'Accepted'},{id:'b',type:'text',x:0,y:30,text:'correction'}];
  assert.equal(shouldRenderConnectorLabel(edge,s),false);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { FigureScene, GroupMember, Primitive, SceneModule } from "../../shared/types";
import { createManualGroup, groupCandidates, isMemberLocked, memberKey, memberLabel, pruneManualGroups,
  resolveGroupMembers, transformManualGroup, ungroupManualGroup } from "../../shared/manual-groups";
import { sceneSvg } from "../../shared/svg";

const rect = (id: string, x = 0): Primitive => ({ id, type: "rect", x, y: 10, width: 20, height: 10, fill: "#ff0000", strokeWidth: 0 });
const module = (id: string, x: number): SceneModule => ({ id, title: id, role: "illustration", brief: "", componentIds: [], labels: [], sourceRefs: [],
  x, y: 30, width: 100, height: 80, ports: [], method: "vector-agent", status: "ready", elements: [rect(id + "-rect")] });
const moduleRef = (id: string): GroupMember => ({ kind: "module", id });
const primitiveRef = (id: string, moduleId?: string): GroupMember => ({ kind: "primitive", id, ...(moduleId ? { moduleId } : {}) });
const groupRef = (id: string, moduleId?: string): GroupMember => ({ kind: "group", id, ...(moduleId ? { moduleId } : {}) });
const lastGroup = (scene: FigureScene) => scene.manualGroups!.at(-1)!;
const fixture = (): FigureScene => ({ schema: "paper-atelier/1", id: "scene", title: "Groups", width: 600, height: 400,
  style: { font: "Arial", ink: "#000000", muted: "#777777", accent: "#0000ff", palette: ["#0000ff"], lineWidth: 1, bodySize: 16, titleSize: 24, illustrationStyle: "native" },
  modules: [module("a", 20), module("b", 180), module("c", 350)], annotations: [rect("back", 10), rect("front", 500)], regions: [],
  connectors: [{ id: "internal", from: "a", to: "b", via: [{ x: 140, y: 20 }], labelAt: { x: 150, y: 15 },
    curveAnchors: { start: { x: 120, y: 70 }, end: { x: 180, y: 70 } },
    curve: [{ c1: { x: 140, y: 30 }, c2: { x: 160, y: 30 }, end: { x: 180, y: 70 }, color: "#123456" }] },
    { id: "external", from: "b", to: "c", via: [{ x: 310, y: 20 }], labelAt: { x: 320, y: 15 } }],
});

test("manual grouping preserves paint order, object identities, and rendered SVG", () => {
  const source = fixture(), before = structuredClone(source);
  const grouped = createManualGroup(source, [moduleRef("b"), primitiveRef("back"), moduleRef("a")], "插画组合");
  assert.deepEqual(source, before);
  assert.equal(grouped.modules, source.modules);
  assert.equal(grouped.annotations, source.annotations);
  assert.equal(grouped.connectors, source.connectors);
  assert.deepEqual(grouped.modules.map(module => module.id), ["a", "b", "c"]);
  assert.deepEqual(lastGroup(grouped).members, [moduleRef("b"), primitiveRef("back"), moduleRef("a")]);
  // SVG embeds the JSON project in metadata; compare actual artwork separately.
  const artwork = (scene: FigureScene) => sceneSvg(scene).replace(/<metadata>[\s\S]*?<\/metadata>/, "");
  assert.equal(artwork(grouped), artwork(source));
  assert.deepEqual(groupCandidates(grouped, ""), [moduleRef("c"), primitiveRef("front"), groupRef(lastGroup(grouped).id)]);
});

test("excluding an object from a proposed selection leaves it unchanged", () => {
  const source = fixture(), proposed = [moduleRef("a"), moduleRef("b"), moduleRef("c")];
  const grouped = createManualGroup(source, proposed.filter(ref => ref.id !== "b"));
  assert.equal(grouped.modules[1], source.modules[1]);
  assert.equal(groupCandidates(grouped, "")[0].id, "b");
  assert.deepEqual(lastGroup(grouped).members.map(ref => ref.id), ["a", "c"]);
});

test("manual groups can be nested, resolve once, and ungroup without moving SVG groups", () => {
  const source = fixture();
  source.annotations.push({ id: "native", type: "group", x: 25, y: 20, opacity: .6, children: [rect("native-leaf")], clip: [{ path: "M0 0H100V100H0Z" }] });
  const inner = createManualGroup(source, [moduleRef("a"), moduleRef("b")]);
  const innerId = lastGroup(inner).id;
  const outer = createManualGroup(inner, [groupRef(innerId), primitiveRef("native")]);
  const outerId = lastGroup(outer).id;
  assert.deepEqual(resolveGroupMembers(outer, groupRef(outerId)), [moduleRef("a"), moduleRef("b"), primitiveRef("native")]);
  assert.deepEqual(groupCandidates(outer, ""), [moduleRef("c"), primitiveRef("back"), primitiveRef("front"), groupRef(outerId)]);
  const dissolvedInner = ungroupManualGroup(outer, innerId);
  assert.equal(dissolvedInner.manualGroups!.length, 1);
  assert.deepEqual(lastGroup(dissolvedInner).members, [moduleRef("a"), moduleRef("b"), primitiveRef("native")]);
  assert.equal(dissolvedInner.annotations, source.annotations);
  const dissolvedOuter = ungroupManualGroup(outer, outerId);
  assert.deepEqual(dissolvedOuter.manualGroups, inner.manualGroups);
  assert.deepEqual(dissolvedOuter.annotations.at(-1), source.annotations.at(-1));
});

test("focus candidates keep native clipping groups atomic and reject cross-scope members", () => {
  const source = fixture();
  source.modules[0].elements = [{ id: "native", type: "group", x: 0, y: 0, opacity: .5, children: [rect("leaf")], clip: [{ path: "M0 0H30V30H0Z" }] }, rect("peer")];
  assert.deepEqual(groupCandidates(source, "a"), [primitiveRef("native", "a"), primitiveRef("peer", "a")]);
  assert.throws(() => createManualGroup(source, [primitiveRef("leaf", "a"), primitiveRef("peer", "a")]), /完整对象/);
  assert.throws(() => createManualGroup(source, [moduleRef("b"), primitiveRef("peer", "a")]), /相同编辑层级/);
  const grouped = createManualGroup(source, groupCandidates(source, "a"));
  assert.equal(lastGroup(grouped).moduleId, "a");
  assert.deepEqual(resolveGroupMembers(grouped, groupRef(lastGroup(grouped).id)), [primitiveRef("native", "a"), primitiveRef("peer", "a")]);
});

test("self, ancestor, and descendant locks exclude candidates and prevent transforms", () => {
  const source = fixture();
  source.modules[0].elements = [{ id: "parent", type: "group", x: 0, y: 0, children: [{ ...rect("locked-leaf"), locked: true }] }, rect("peer")];
  source.modules[1].locked = true;
  source.annotations[0].locked = true;
  assert.equal(isMemberLocked(source, moduleRef("a")), true);
  assert.equal(isMemberLocked(source, primitiveRef("parent", "a")), true);
  assert.equal(isMemberLocked(source, primitiveRef("b-rect", "b")), true);
  assert.deepEqual(groupCandidates(source, ""), [moduleRef("c"), primitiveRef("front")]);
  assert.deepEqual(groupCandidates(source, "a"), [primitiveRef("peer", "a")]);
  assert.throws(() => createManualGroup(source, [moduleRef("a"), moduleRef("c")]), /锁定/);
  source.modules[0].elements[0].locked = true;
  source.modules[0].elements[0].children![0].locked = false;
  assert.equal(isMemberLocked(source, primitiveRef("locked-leaf", "a")), true);
  const grouped = createManualGroup(fixture(), [moduleRef("a"), moduleRef("b")]);
  grouped.modules[0].elements[0].locked = true;
  assert.equal(isMemberLocked(grouped, groupRef(lastGroup(grouped).id)), true);
  assert.throws(() => transformManualGroup(grouped, lastGroup(grouped).id, { originX: 0, originY: 0, scale: 1, dx: 3, dy: 4 }), /锁定/);
});

test("whole-figure transforms update internal connector geometry and preserve external bindings", () => {
  const source = createManualGroup(fixture(), [moduleRef("a"), moduleRef("b"), primitiveRef("front")]);
  const before = structuredClone(source), id = lastGroup(source).id;
  const transformed = transformManualGroup(source, id, { originX: 10, originY: 20, scale: 2, dx: 5, dy: -3 });
  assert.deepEqual(source, before);
  assert.deepEqual(transformed.modules.map(module => module.id), ["a", "b", "c"]);
  assert.equal(transformed.modules[0].x, 35);
  assert.equal(transformed.modules[0].y, 37);
  assert.equal(transformed.modules[0].width, 200);
  assert.equal(transformed.modules[0].height, 160);
  assert.equal(transformed.modules[0].contentWidth, 100, "implicit content dimensions must be fixed before module resize");
  assert.equal(transformed.modules[0].contentHeight, 80);
  assert.deepEqual(transformed.modules[0].elements, before.modules[0].elements);
  assert.deepEqual(transformed.modules[2], before.modules[2]);
  assert.deepEqual(transformed.annotations[1], { ...before.annotations[1], x: 995, y: -3, scaleX: 2, scaleY: 2 });
  assert.deepEqual(transformed.connectors[0].via, [{ x: 275, y: 17 }]);
  assert.deepEqual(transformed.connectors[0].labelAt, { x: 295, y: 7 });
  assert.deepEqual(transformed.connectors[0].curveAnchors, { start: { x: 235, y: 117 }, end: { x: 355, y: 117 } });
  assert.deepEqual(transformed.connectors[0].curve, [{ c1: { x: 275, y: 37 }, c2: { x: 315, y: 37 }, end: { x: 355, y: 117 }, color: "#123456" }]);
  assert.deepEqual(transformed.connectors[1], before.connectors[1]);
  assert.equal(transformed.connectors[0].from, "a");
  assert.equal(transformed.connectors[0].to, "b");
  const undone = structuredClone(before);
  assert.deepEqual(undone, source, "undo can restore the saved snapshot without derived mutations");
});

test("focused transforms convert world coordinates through unequal module scales", () => {
  const source = fixture(), module = source.modules[0];
  module.x = 100; module.y = 50; module.width = 200; module.height = 240; module.contentWidth = 100; module.contentHeight = 80;
  const native: Primitive = { id: "native", type: "group", x: 10, y: 20, scaleX: 1, scaleY: -.5, opacity: .4,
    children: [rect("leaf", 5)], clip: [{ path: "M0 0H30V30H0Z" }],
    svgShadow: { dx: 0, dy: 3, spread: 0, color: "rgba(0,0,0,1)", knockout: false, region: { x: 0, y: 0, width: 30, height: 30 } } };
  module.elements = [native, rect("peer", 30)];
  const grouped = createManualGroup(source, groupCandidates(source, "a"));
  const moved = transformManualGroup(grouped, lastGroup(grouped).id, { originX: 110, originY: 80, scale: 2, dx: 6, dy: -9 });
  const result = moved.modules[0].elements[0];
  assert.equal(result.x, 18); // (120-110)*2+110+6 = 136 world; local (136-100)/2.
  assert.equal(result.y, 27); // (110-80)*2+80-9 = 131 world; local (131-50)/3.
  assert.equal(result.scaleX, 2); assert.equal(result.scaleY, -1);
  assert.deepEqual(result.children, native.children);
  assert.deepEqual(result.clip, native.clip);
  assert.deepEqual(result.svgShadow, native.svgShadow);
  assert.deepEqual(moved.connectors, source.connectors);
  assert.equal(moved.modules[0].x, 100); assert.equal(moved.modules[0].width, 200);
});

test("nested manual transforms touch every real object exactly once and ungroup keeps edits", () => {
  const inner = createManualGroup(fixture(), [moduleRef("a"), moduleRef("b")]);
  const outer = createManualGroup(inner, [groupRef(lastGroup(inner).id), moduleRef("c")]);
  const moved = transformManualGroup(outer, lastGroup(outer).id, { originX: 0, originY: 0, scale: 1, dx: 15, dy: 7 });
  assert.deepEqual(moved.modules.map(module => module.x), [35, 195, 365]);
  const ungrouped = ungroupManualGroup(moved, lastGroup(moved).id);
  assert.deepEqual(ungrouped.modules, moved.modules);
  assert.equal(ungrouped.manualGroups!.length, 1);
});

test("pruning missing refs dissolves short groups into their parent without touching artwork", () => {
  const inner = createManualGroup(fixture(), [moduleRef("a"), moduleRef("b")]);
  const outer = createManualGroup(inner, [groupRef(lastGroup(inner).id), moduleRef("c")]);
  const removed = { ...outer, modules: outer.modules.filter(module => module.id !== "b") };
  const repaired = pruneManualGroups(removed);
  assert.equal(repaired.modules, removed.modules);
  assert.equal(repaired.annotations, removed.annotations);
  assert.deepEqual(repaired.manualGroups!.map(group => group.id), [lastGroup(outer).id]);
  assert.deepEqual(lastGroup(repaired).members, [moduleRef("a"), moduleRef("c")]);
  assert.equal(pruneManualGroups(repaired), repaired, "repair is idempotent");
});

test("pruning cycles, duplicates, missing scopes and refs terminates and retains every source object", () => {
  const source = fixture();
  source.manualGroups = [
    { id: "one", title: "one", members: [groupRef("two"), moduleRef("a"), moduleRef("a"), moduleRef("missing")] },
    { id: "two", title: "two", members: [groupRef("one"), moduleRef("b"), moduleRef("c")] },
    { id: "duplicate-owner", title: "dup", members: [moduleRef("a"), primitiveRef("back")] },
    { id: "bad-scope", title: "bad", moduleId: "missing", members: [primitiveRef("back"), primitiveRef("front")] },
  ];
  assert.deepEqual(resolveGroupMembers(source, groupRef("one")).map(ref => ref.id), ["b", "c", "a"]);
  const repaired = pruneManualGroups(source);
  assert.equal(repaired.modules, source.modules);
  assert.equal(repaired.annotations, source.annotations);
  assert.equal(repaired.connectors, source.connectors);
  assert.equal(pruneManualGroups(repaired), repaired);
  assert.deepEqual(repaired.manualGroups!.map(group => group.id), ["one", "two"]);
  const refs = repaired.manualGroups!.flatMap(group => group.members.map(memberKey));
  assert.equal(refs.length, new Set(refs).size);
  assert.deepEqual(resolveGroupMembers(repaired, groupRef("one")).map(ref => ref.id), ["b", "c", "a"]);
});

test("group creation rejects duplicate-only selections and covered atomic members", () => {
  const source = fixture();
  assert.throws(() => createManualGroup(source, [moduleRef("a"), moduleRef("a")]), /至少选择两个/);
  assert.throws(() => createManualGroup(source, [moduleRef("a"), moduleRef("missing")]), /已经不存在/);
  const grouped = createManualGroup(source, [moduleRef("a"), moduleRef("b")]);
  assert.throws(() => createManualGroup(grouped, [moduleRef("a"), moduleRef("c")]), /完整对象/);
  assert.throws(() => transformManualGroup(grouped, lastGroup(grouped).id, { originX: 0, originY: 0, scale: 0, dx: 0, dy: 0 }), /等比缩放/);
  assert.throws(() => transformManualGroup(grouped, lastGroup(grouped).id, { originX: NaN, originY: 0, scale: 1, dx: 0, dy: 0 }), /等比缩放/);
  assert.throws(() => transformManualGroup(grouped, lastGroup(grouped).id, { scale: 1 } as any), /等比缩放/);
  assert.throws(() => transformManualGroup(grouped, lastGroup(grouped).id, { originX: 0, originY: 0, scale: Number.MAX_VALUE, dx: 0, dy: 0 }), /有效坐标范围/);
  assert.deepEqual(groupCandidates(source, "missing"), []);
});

test("manual group metadata survives JSON round trips with collision-safe keys", () => {
  const grouped = createManualGroup(fixture(), [moduleRef("a"), moduleRef("b")], "结构总组");
  const restored = JSON.parse(JSON.stringify(grouped)) as FigureScene;
  assert.deepEqual(pruneManualGroups(restored), grouped);
  assert.equal(memberLabel(restored, groupRef(lastGroup(restored).id)), "结构总组");
  assert.equal(memberLabel(restored, moduleRef("a")), "a");
  assert.notEqual(memberKey(primitiveRef("c", "a:b")), memberKey(primitiveRef("b:c", "a")));
  assert.equal(ungroupManualGroup(restored, "missing"), restored);
});

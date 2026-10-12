import type { FigureScene, GroupMember, ManualGroup, Point, Primitive } from "./types";

export function memberKey(ref: GroupMember): string {
  return JSON.stringify([ref.kind, ref.moduleId || "", ref.id]);
}

function groupRef(group: ManualGroup): GroupMember {
  return { kind: "group", id: group.id, ...(group.moduleId ? { moduleId: group.moduleId } : {}) };
}

function primitivePath(items: Primitive[], id: string): Primitive[] | undefined {
  for (const item of items) {
    if (item.id === id) return [item];
    const child = item.children && primitivePath(item.children, id);
    if (child) return [item, ...child];
  }
}

function primitiveFor(scene: FigureScene, ref: GroupMember): Primitive[] | undefined {
  const items = ref.moduleId ? scene.modules.find(module => module.id === ref.moduleId)?.elements : scene.annotations;
  return items && primitivePath(items, ref.id);
}

function validRef(ref: unknown): ref is GroupMember {
  if (!ref || typeof ref !== "object") return false;
  const value = ref as GroupMember;
  return ["module", "primitive", "group"].includes(value.kind) && typeof value.id === "string" && !!value.id &&
    (value.moduleId === undefined || typeof value.moduleId === "string");
}

/** Resolve scope from the current document, never from an outdated group reference. */
function canonicalRef(scene: FigureScene, ref: GroupMember): GroupMember | undefined {
  if (!validRef(ref)) return;
  if (ref.kind === "module") {
    if (!ref.moduleId && scene.modules.some(module => module.id === ref.id)) return { kind: "module", id: ref.id };
  } else if (ref.kind === "group") {
    const group = scene.manualGroups?.find(group => group.id === ref.id);
    if (group && (!ref.moduleId || ref.moduleId === group.moduleId)) return groupRef(group);
  } else if (primitiveFor(scene, ref)) {
    return { kind: "primitive", id: ref.id, ...(ref.moduleId ? { moduleId: ref.moduleId } : {}) };
  }
}

export function memberLabel(scene: FigureScene, ref: GroupMember): string {
  if (ref.kind === "group") return scene.manualGroups?.find(group => group.id === ref.id)?.title || ref.id;
  if (ref.kind === "module") return scene.modules.find(module => module.id === ref.id)?.title || ref.id;
  const primitive = primitiveFor(scene, ref)?.at(-1);
  if (primitive?.type === "text") return primitive.text?.trim().slice(0, 80) || "文字";
  const labels: Partial<Record<Primitive["type"], string>> = {
    rect: "矩形", ellipse: "椭圆", path: "路径", line: "线条", polygon: "多边形", group: "原始分组", image: "图片", symbol: "图标",
  };
  return primitive ? `${labels[primitive.type] ?? "对象"} · ${primitive.id}` : ref.id;
}

/** Manual groups are references. Native SVG groups remain indivisible primitives. */
export function resolveGroupMembers(scene: FigureScene, ref: GroupMember): GroupMember[] {
  const output: GroupMember[] = [], seen = new Set<string>(), visiting = new Set<string>();
  const visit = (requested: GroupMember) => {
    const member = canonicalRef(scene, requested);
    if (!member) return;
    if (member.kind !== "group") {
      const key = memberKey(member);
      if (!seen.has(key)) { seen.add(key); output.push(member); }
      return;
    }
    if (visiting.has(member.id)) return;
    visiting.add(member.id);
    const group = scene.manualGroups!.find(group => group.id === member.id)!;
    for (const child of group.members ?? []) if (validRef(child)) visit(child);
    visiting.delete(member.id);
  };
  visit(ref);
  return output;
}

function subtreeLocked(item: Primitive): boolean {
  return !!item.locked || !!item.children?.some(subtreeLocked);
}

export function isMemberLocked(scene: FigureScene, ref: GroupMember): boolean {
  const member = canonicalRef(scene, ref);
  if (!member) return true;
  if (member.kind === "group") {
    const members = resolveGroupMembers(scene, member);
    return !members.length || members.some(child => isMemberLocked(scene, child));
  }
  if (member.kind === "module") {
    const module = scene.modules.find(module => module.id === member.id)!;
    return !!module.locked || module.elements.some(subtreeLocked);
  }
  const module = member.moduleId ? scene.modules.find(module => module.id === member.moduleId) : undefined;
  const path = primitiveFor(scene, member)!;
  return !!module?.locked || path.some(item => !!item.locked) || subtreeLocked(path.at(-1)!);
}

function directRef(scene: FigureScene, ref: GroupMember, scope: string | undefined): boolean {
  if ((ref.moduleId || undefined) !== scope) return false;
  if (ref.kind === "group") return true;
  if (ref.kind === "module") return !scope;
  const items = scope ? scene.modules.find(module => module.id === scope)?.elements : scene.annotations;
  return !!items?.some(item => item.id === ref.id);
}

function uniqueMembers(members: GroupMember[]): GroupMember[] {
  const seen = new Set<string>();
  return members.filter(member => {
    const key = memberKey(member);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Repair only logical references; pruning never removes, moves, or reorders artwork. */
export function pruneManualGroups(scene: FigureScene): FigureScene {
  if (!scene.manualGroups?.length) return scene;
  const ids = new Set<string>();
  let groups = scene.manualGroups.filter(group => {
    if (!group || typeof group.id !== "string" || !group.id || ids.has(group.id) || !Array.isArray(group.members)) return false;
    if (group.moduleId && !scene.modules.some(module => module.id === group.moduleId)) return false;
    ids.add(group.id); return true;
  }).map(group => ({ id: group.id, title: typeof group.title === "string" && group.title.trim() ? group.title : "组合",
    ...(group.moduleId ? { moduleId: group.moduleId } : {}), members: [...group.members] } as ManualGroup));
  const working = { ...scene, manualGroups: groups };
  for (const group of groups) {
    group.members = uniqueMembers(group.members.flatMap(ref => {
      const member = canonicalRef(working, ref);
      return member && directRef(working, member, group.moduleId) && !(member.kind === "group" && member.id === group.id) ? [member] : [];
    }));
  }
  // Remove back edges before expanding short groups. A reference has one parent.
  const finished = new Set<string>(), visiting = new Set<string>();
  const visit = (group: ManualGroup) => {
    if (finished.has(group.id)) return;
    visiting.add(group.id);
    group.members = group.members.filter(member => {
      if (member.kind !== "group") return true;
      if (visiting.has(member.id)) return false;
      const child = groups.find(candidate => candidate.id === member.id);
      if (!child) return false;
      visit(child); return true;
    });
    visiting.delete(group.id); finished.add(group.id);
  };
  groups.forEach(visit);
  for (;;) {
    const owners = new Set<string>();
    for (const group of groups) group.members = group.members.filter(member => {
      const key = memberKey(member);
      if (owners.has(key)) return false;
      owners.add(key); return true;
    });
    const short = new Map(groups.filter(group => group.members.length < 2).map(group => [group.id, group]));
    if (!short.size) break;
    const expand = (members: GroupMember[]): GroupMember[] => uniqueMembers(members.flatMap(member =>
      member.kind === "group" && short.has(member.id) ? expand(short.get(member.id)!.members) : [member]));
    groups = groups.filter(group => !short.has(group.id)).map(group => ({ ...group, members: expand(group.members) }));
  }
  return JSON.stringify(groups) === JSON.stringify(scene.manualGroups) ? scene : { ...scene, manualGroups: groups };
}

export function groupCandidates(scene: FigureScene, focus: string): GroupMember[] {
  const clean = pruneManualGroups(scene), scope = focus || undefined;
  if (scope && !clean.modules.some(module => module.id === scope)) return [];
  const groups = (clean.manualGroups ?? []).filter(group => group.moduleId === scope);
  const covered = new Set(groups.flatMap(group => group.members.map(memberKey)));
  const physical: GroupMember[] = scope
    ? clean.modules.find(module => module.id === scope)!.elements.map(item => ({ kind: "primitive", id: item.id, moduleId: scope }))
    : [...clean.modules.map(module => ({ kind: "module" as const, id: module.id })),
      ...clean.annotations.map(item => ({ kind: "primitive" as const, id: item.id }))];
  return [...physical, ...groups.map(groupRef)].filter(ref => !covered.has(memberKey(ref)) && !isMemberLocked(clean, ref));
}

export function createManualGroup(scene: FigureScene, members: GroupMember[], title?: string): FigureScene {
  const clean = pruneManualGroups(scene);
  const canonical = members.map(ref => canonicalRef(clean, ref));
  if (canonical.some(ref => !ref)) throw new Error("所选对象已经不存在，请重新选择。");
  const selected = uniqueMembers(canonical as GroupMember[]);
  if (selected.length < 2) throw new Error("至少选择两个对象才能组合。");
  const scope = selected[0].moduleId;
  if (selected.some(ref => ref.moduleId !== scope)) throw new Error("只能组合相同编辑层级的对象。");
  if (selected.some(ref => isMemberLocked(clean, ref))) throw new Error("所选对象、父级或内部对象已锁定，不能组合。");
  const candidates = new Set(groupCandidates(clean, scope ?? "").map(memberKey));
  if (selected.some(ref => !candidates.has(memberKey(ref)))) throw new Error("请选择当前层级的完整对象或组合，不能拆开原始分组。");
  const group: ManualGroup = { id: `group-${crypto.randomUUID()}`, title: title?.trim() || `组合 ${(clean.manualGroups?.length ?? 0) + 1}`,
    ...(scope ? { moduleId: scope } : {}), members: selected };
  return { ...clean, manualGroups: [...(clean.manualGroups ?? []), group] };
}

export function ungroupManualGroup(scene: FigureScene, id: string): FigureScene {
  const clean = pruneManualGroups(scene), removed = clean.manualGroups?.find(group => group.id === id);
  if (!removed) return clean;
  return pruneManualGroups({ ...clean, manualGroups: clean.manualGroups!.filter(group => group.id !== id).map(group => ({ ...group,
    members: uniqueMembers(group.members.flatMap(member => member.kind === "group" && member.id === id ? removed.members : [member])),
  })) });
}

export interface ManualGroupTransform {
  originX: number;
  originY: number;
  scale: number;
  dx: number;
  dy: number;
}

/** Apply one world-space similarity transform without reparenting SVG primitives. */
export function transformManualGroup(scene: FigureScene, id: string, transform: ManualGroupTransform): FigureScene {
  if ([transform.originX, transform.originY, transform.scale, transform.dx, transform.dy].some(value => !Number.isFinite(value)) || !(transform.scale > 0)) throw new Error("组合变换必须使用有限坐标和大于零的等比缩放。");
  const clean = pruneManualGroups(scene), group = clean.manualGroups?.find(group => group.id === id);
  if (!group) throw new Error("该组合已经不存在。");
  const ref = groupRef(group);
  if (isMemberLocked(clean, ref)) throw new Error("组合、父级或内部对象已锁定，不能移动或缩放。");
  const members = resolveGroupMembers(clean, ref), next = structuredClone(clean), movedModules = new Set<string>();
  const { originX, originY, scale, dx, dy } = transform;
  const finite = (value: number) => {
    if (!Number.isFinite(value)) throw new Error("组合变换超出有效坐标范围。");
    return value;
  };
  const point = (point: Point): Point => ({ x: finite(originX + (point.x - originX) * scale + dx), y: finite(originY + (point.y - originY) * scale + dy) });
  for (const member of members) {
    if (member.kind === "module") {
      const module = next.modules.find(module => module.id === member.id)!;
      module.contentWidth ??= module.width;
      module.contentHeight ??= module.height;
      Object.assign(module, point(module), { width: finite(module.width * scale), height: finite(module.height * scale) });
      movedModules.add(module.id);
    } else {
      const module = member.moduleId ? next.modules.find(module => module.id === member.moduleId) : undefined;
      const primitive = primitiveFor(next, member)!.at(-1)!;
      const sx = module ? module.width / (module.contentWidth ?? module.width) : 1;
      const sy = module ? module.height / (module.contentHeight ?? module.height) : 1;
      if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) throw new Error("模块尺寸无效，无法转换组合坐标。");
      const before = { x: (module?.x ?? 0) + primitive.x * sx, y: (module?.y ?? 0) + primitive.y * sy };
      const after = point(before);
      primitive.x = finite((after.x - (module?.x ?? 0)) / sx);
      primitive.y = finite((after.y - (module?.y ?? 0)) / sy);
      primitive.scaleX = finite((primitive.scaleX ?? 1) * scale);
      primitive.scaleY = finite((primitive.scaleY ?? 1) * scale);
    }
  }
  for (const connector of next.connectors) {
    if (!movedModules.has(connector.from) || !movedModules.has(connector.to)) continue;
    if (connector.via) connector.via = connector.via.map(point);
    if (connector.labelAt) connector.labelAt = point(connector.labelAt);
    if (connector.curve) connector.curve = connector.curve.map(segment => ({ ...segment, c1: point(segment.c1), c2: point(segment.c2), end: point(segment.end) }));
    if (connector.curveAnchors) connector.curveAnchors = { start: point(connector.curveAnchors.start), end: point(connector.curveAnchors.end) };
  }
  return next;
}

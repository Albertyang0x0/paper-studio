import { Canvas, Control, Rect, controlsUtils, util, type FabricObject, type TMat2D } from "fabric";
import type { FigureScene, GroupMember, Primitive } from "../../shared/types";
import { isMemberLocked, resolveGroupMembers } from "../../shared/manual-groups";
import { fabricObjectTree } from "./svg-canvas";

export type GroupBounds = { left: number; top: number; width: number; height: number };
type ObjectMeta = { kind: string; id: string; moduleId?: string };
type ProxyData = ObjectMeta & {
  kind: "manual-group";
  bounds: GroupBounds;
  originals: { object: FabricObject; matrix: TMat2D }[];
};
const metaOf = (object: FabricObject): ObjectMeta | undefined => (object as any).atelier;
export const proxyData = (object: FabricObject | undefined): ProxyData | undefined =>
  object && metaOf(object)?.kind === "manual-group" ? (object as any).atelier : undefined;

export function objectsForMember(canvas: Canvas, scene: FigureScene, member: GroupMember): FabricObject[] {
  const tree = fabricObjectTree(canvas.getObjects()), result = new Set<FabricObject>();
  for (const ref of resolveGroupMembers(scene, member)) {
    const object = tree.find(object => {
      const meta = metaOf(object);
      return meta?.kind === (ref.kind === "module" ? "module" : "primitive") && meta.id === ref.id &&
        (ref.kind === "module" || meta.moduleId === ref.moduleId);
    });
    if (object) { result.add(object); continue; }
    // Non-SVG module editing renders native group descendants individually.
    if (ref.kind === "primitive") {
      const items = ref.moduleId ? scene.modules.find(module => module.id === ref.moduleId)?.elements : scene.annotations;
      const descend = (items: Primitive[]): Primitive[] => items.flatMap(item => [item, ...descend(item.children ?? [])]);
      const primitive = descend(items ?? []).find(item => item.id === ref.id);
      const ids = new Set(descend(primitive?.children ?? []).map(item => item.id));
      for (const child of tree) {
        const meta = metaOf(child);
        if (meta?.kind === "primitive" && meta.moduleId === ref.moduleId && ids.has(meta.id)) result.add(child);
      }
    }
  }
  return [...result];
}

export function boundsForMember(canvas: Canvas, scene: FigureScene, member: GroupMember): GroupBounds | undefined {
  const bounds = objectsForMember(canvas, scene, member).map(object => object.getBoundingRect());
  if (!bounds.length) return;
  const left = Math.min(...bounds.map(box => box.left)), top = Math.min(...bounds.map(box => box.top));
  return { left, top, width: Math.max(1, Math.max(...bounds.map(box => box.left + box.width)) - left),
    height: Math.max(1, Math.max(...bounds.map(box => box.top + box.height)) - top) };
}

export function createManualGroupProxy(canvas: Canvas, scene: FigureScene, id: string, editable: boolean): Rect | undefined {
  const member: GroupMember = { kind: "group", id }, bounds = boundsForMember(canvas, scene, member);
  if (!bounds) return;
  const canEdit = editable && !isMemberLocked(scene, member);
  const proxy = new Rect({ ...bounds, fill: "transparent", strokeWidth: 0, objectCaching: false,
    originX: "left", originY: "top", selectable: canEdit, evented: canEdit,
    lockRotation: true, lockScalingFlip: true, lockMovementX: !canEdit, lockMovementY: !canEdit,
    lockScalingX: !canEdit, lockScalingY: !canEdit, borderColor: "#2563eb", cornerColor: "#2563eb",
    transparentCorners: false, cornerSize: 10 });
  proxy.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false, mtr: false });
  proxy.controls = { ...proxy.controls };
  for (const corner of ["tl", "tr", "bl", "br"]) {
    const original = proxy.controls[corner];
    proxy.controls[corner] = new Control({ ...original, actionHandler: (event, transform, x, y) => {
      const c = transform.target.canvas;
      // A logical group may contain rotated text/paths; uniform scaling keeps
      // their existing transform representable without introducing skew.
      return controlsUtils.scalingEqually({ ...event, [c?.uniScaleKey ?? "shiftKey"]: !c?.uniformScaling }, transform, x, y);
    } });
  }
  (proxy as any).atelier = { kind: "manual-group", id, bounds,
    originals: objectsForMember(canvas, scene, member).map(object => ({ object, matrix: [...object.calcTransformMatrix()] })) } satisfies ProxyData;
  return proxy;
}

export function manualGroupTransform(proxy: FabricObject) {
  const data = proxyData(proxy)!;
  return { originX: data.bounds.left, originY: data.bounds.top, scale: proxy.scaleX,
    dx: proxy.left - data.bounds.left, dy: proxy.top - data.bounds.top };
}

export function previewManualGroup(proxy: FabricObject, restore = false) {
  const data = proxyData(proxy);
  if (!data) return;
  const transform = manualGroupTransform(proxy), scale = restore ? 1 : transform.scale;
  const world: TMat2D = [scale, 0, 0, scale,
    restore ? 0 : transform.originX * (1 - scale) + transform.dx,
    restore ? 0 : transform.originY * (1 - scale) + transform.dy];
  for (const { object, matrix } of data.originals) {
    let changed = util.multiplyTransformMatrices(world, matrix);
    if (object.group) changed = util.multiplyTransformMatrices(util.invertTransform(object.group.calcTransformMatrix()), changed);
    util.applyTransformToObject(object, changed);
    object.setCoords();
    for (let parent = object.group; parent; parent = parent.group) parent.dirty = true;
  }
}

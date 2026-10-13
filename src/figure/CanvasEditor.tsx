import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  Canvas,
  Rect,
  Ellipse,
  IText,
  Path,
  Polygon,
  Line,
  Group,
  Gradient,
  Triangle,
  Point,
  util,
  type FabricObject,
} from "fabric";
import { Maximize2, Minus, Plus, MousePointer2, ArrowLeft } from "lucide-react";
import type { FigureScene, GroupMember, Primitive, SceneModule } from "../../shared/types";
import { groupCandidates, memberKey, transformManualGroup } from "../../shared/manual-groups";
import { boundsForMember, createManualGroupProxy, manualGroupTransform, objectsForMember, previewManualGroup, proxyData, type GroupBounds } from "./canvas-groups";
import { connectorGeometry,shouldRenderConnectorLabel } from "../../shared/svg";
import { expandPrimitive } from "../../shared/assets";
import { displayMath } from "../../shared/math-text";
import { canvasPaint } from "../../shared/canvas-paint";
import { applySvgClips, fabricObjectTree, prepareSvgCanvasResources, SvgCompositingGroup, svgGroupLayout, SvgRasterObject, SvgShadowGroup, type SvgCanvasResources } from "./svg-canvas";
import { svgUnderlineKey } from "./svg-text-decoration";

type Selection = {
  groupId?: string;
  moduleId?: string;
  elementId?: string;
  connectorId?: string;
  regionId?: string;
  kind?: string;
};
type Props = {
  scene?: FigureScene;
  focus: string;
  selection: Selection;
  onFocus: (id: string) => void;
  onSelect: (s: Selection) => void;
  onChange: (scene: FigureScene) => void;
  editable: boolean;
  boxSelect: boolean;
  groupingReview?: boolean;
  onBoxSelect: (members: GroupMember[]) => void;
  draftMembers: GroupMember[];
  previewMember?: GroupMember;
};
type Meta = {
  kind: string;
  id: string;
  moduleId?: string;
  primitive?: Primitive;
  startLeft?: number;
  startTop?: number;
  sx?: number;
  sy?: number;
  baseScaleX?: number;
  baseScaleY?: number;
  svgFrameOffset?: { x: number; y: number };
  svgPrimitiveOffset?: { x: number; y: number };
  svgTree?: boolean;
  baseFlipX?: boolean;
  baseFlipY?: boolean;
};
const tag = (o: FabricObject, data: Meta) => {
  (o as any).atelier = data;
  return o;
};
const boardBackground = () => getComputedStyle(document.documentElement).getPropertyValue('--ui-bg').trim() || '#181818';
const viewDirections: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};
export function fabricPrimitive(
  raw: Primitive,
  style: FigureScene["style"],
  svgCoordinates = false,
  resources?: SvgCanvasResources,
  visit?: (object: FabricObject, primitive: Primitive) => void,
): FabricObject {
  const e = expandPrimitive(raw),
    options = {
      fill: e.gradient ? new Gradient({
        type: "linear", gradientUnits: "percentage",
        coords: { x1: e.gradient.x1, y1: e.gradient.y1, x2: e.gradient.x2, y2: e.gradient.y2 },
        colorStops: e.gradient.stops,
      }) : canvasPaint(e.fill, e.type === "text" ? style.ink : ""),
      stroke: canvasPaint(e.stroke),
      strokeWidth: e.strokeWidth ?? style.lineWidth,
      opacity: e.opacity ?? 1,
      strokeDashArray: e.dash,
      fillRule: e.fillRule ?? "nonzero",
      strokeLineCap: e.strokeLineCap ?? "butt",
      strokeLineJoin: e.strokeLineJoin ?? "miter",
      strokeMiterLimit: e.strokeMiterLimit ?? 4,
      strokeDashOffset: e.strokeDashOffset ?? 0,
      paintFirst: e.paintOrder === "stroke fill" ? "stroke" as const : "fill" as const,
      angle: svgCoordinates ? 0 : e.rotation ?? 0,
      originX: "left" as const,
      originY: "top" as const,
      objectCaching: false,
    };
  let o: FabricObject;
  const shadow = e.svgShadow ? resources?.shadows.get(e.id) : undefined;
  if (e.svgShadow) {
    if (!shadow) throw new Error("SVG 阴影资源尚未加载。");
    if (e.type === "group") {
      o = new SvgShadowGroup((e.children ?? []).map(child => fabricPrimitive(child, style, svgCoordinates, resources, visit)), shadow.image, shadow.box,
        { ...options, strokeWidth: 0, subTargetCheck: true, interactive: true, layoutManager: svgGroupLayout() });
    } else {
      o = new SvgRasterObject(shadow.image, shadow.box.width, shadow.box.height);
      o.set({ ...options, strokeWidth: 0, left: shadow.box.x, top: shadow.box.y });
    }
  } else if (e.type === "image") {
    const image = resources?.images.get(e.assetId ?? "");
    if (!image) throw new Error("SVG 图片资源不存在或尚未加载。");
    o = new SvgRasterObject(image, e.width ?? image.naturalWidth, e.height ?? image.naturalHeight);
    o.set({ ...options, strokeWidth: 0 });
  } else if (e.type === "rect")
    o = new Rect({
      ...options,
      width: e.width ?? 10,
      height: e.height ?? 10,
      rx: e.radius ?? 0,
      ry: e.radius ?? 0,
    });
  else if (e.type === "ellipse")
    o = new Ellipse({
      ...options,
      rx: (e.width ?? 10) / 2,
      ry: (e.height ?? 10) / 2,
    });
  else if (e.type === "line")
    o = new Line([0, 0, e.width ?? 0, e.height ?? 0], options);
  else if (e.type === "polygon") o = new Polygon(e.points ?? [], options);
  else if (e.type === "path") o = new Path(e.path ?? "", options);
  else if (e.type === "text") {
    const text = new IText(svgCoordinates ? e.text ?? "" : displayMath(e.text ?? ""), {
      ...options,
      fontSize: e.fontSize ?? style.bodySize,
      fontFamily: (e.fontFamily ?? style.font).trim(),
      fontWeight: e.fontWeight ?? 400,
      charSpacing: (e.letterSpacing ?? 0) / Math.max(e.fontSize ?? style.bodySize, Number.EPSILON) * 1000,
      fontStyle: e.italic ? "italic" : "normal",
      underline: e.underline ?? false,
      lineHeight: 1.24,
      textAlign: e.align ?? "left",
      padding: 3,
    });
    // Match the native document contract used by SVG: baseline .92*fontSize,
    // line advance 1.24*fontSize. Fabric otherwise multiplies line height 1.13.
    text._fontSizeMult=1;
    text._fontSizeFraction=.08;
    const underline = e.underline && resources?.underlines?.get(svgUnderlineKey(e, style));
    if (underline) {
      text.offsets = { ...text.offsets, underline: underline.offset / text.fontSize };
      text.textDecorationThickness = underline.thickness / text.fontSize * 1000;
    }
    text.initDimensions();
    o=text;
  }
  else {
    const children = (e.children ?? []).map((child) => fabricPrimitive(child, style, svgCoordinates, resources, visit));
    o = svgCoordinates
      ? new SvgCompositingGroup(children, { ...options, strokeWidth: 0, subTargetCheck: true, interactive: true, layoutManager: svgGroupLayout() })
      : new Group(children, { ...options, subTargetCheck: false });
  }
  const naturalLeft = o.left,
    naturalTop = o.top;
  const preserveBounds =
    !!shadow || e.type === "path" || e.type === "polygon" || e.type === "group";
  // SVG positions describe geometry, while Fabric origins include half the
  // stroke. Paths already expose that offset through their natural bounds.
  const strokeOffset = svgCoordinates && !shadow && (e.type === "rect" || e.type === "ellipse" || e.type === "text")
    ? -(e.strokeWidth ?? style.lineWidth) / 2
    : 0;
  const px = (preserveBounds ? naturalLeft : strokeOffset) * (e.scaleX ?? 1),
    py = (preserveBounds ? naturalTop : strokeOffset) * (e.scaleY ?? 1),
    radians = svgCoordinates ? (e.rotation ?? 0) * Math.PI / 180 : 0,
    cos = Math.cos(radians), sin = Math.sin(radians);
  const naturalCenter = o.getRelativeCenterPoint();
  o.set({
    left: e.x + px * cos - py * sin,
    top: e.y + px * sin + py * cos,
    scaleX: e.scaleX ?? 1,
    scaleY: e.scaleY ?? 1,
    angle: e.rotation ?? 0,
  });
  if (svgCoordinates) {
    // SVG negative scales mirror around the geometry origin. Fabric stores
    // flips separately, so position the transformed center explicitly.
    let cx = (preserveBounds ? naturalLeft : strokeOffset) + naturalCenter.x - naturalLeft;
    const cy = (preserveBounds ? naturalTop : strokeOffset) + naturalCenter.y - naturalTop;
    if (e.type === "text" && !shadow) {
      if (e.align === "center") cx += ((e.width ?? 0) - o.width) / 2;
      if (e.align === "right") cx += (e.width ?? 0) - o.width;
    }
    const x = cx * (e.scaleX ?? 1), y = cy * (e.scaleY ?? 1);
    o.setPositionByOrigin(new Point(e.x + x * cos - y * sin, e.y + x * sin + y * cos), "center", "center");
    applySvgClips(o, e);
  }
  if (!svgCoordinates && e.type === "text" && e.align === "center")
    o.set("left", e.x + ((e.width ?? 0) - o.width) / 2);
  if (!svgCoordinates && e.type === "text" && e.align === "right")
    o.set("left", e.x + (e.width ?? 0) - o.width);
  visit?.(o, e);
  return o;
}

/** Keep the SVG coordinate frame fixed when edited ink extends outside it. */
export function alignSvgModuleFrame(group: Group, frame: Rect, module: Pick<SceneModule, "x" | "y">) {
  const position = frame.getXY();
  const offset = {
    x: (position.x - group.left) / group.scaleX,
    y: (position.y - group.top) / group.scaleY,
  };
  group.set({
    left: module.x - offset.x * group.scaleX,
    top: module.y - offset.y * group.scaleY,
  });
  group.setCoords();
  return offset;
}

/** Persist a native child in its original SVG parent coordinate system. */
export function svgPrimitiveEdit(
  primitive: Primitive,
  object: FabricObject,
  before: Pick<Meta, "startLeft" | "startTop" | "baseScaleX" | "baseScaleY" | "baseFlipX" | "baseFlipY" | "svgPrimitiveOffset">,
  style: FigureScene["style"],
  resources?: SvgCanvasResources,
): Primitive {
  const updated = {
    ...primitive,
    x: primitive.x + object.left - (before.startLeft ?? object.left),
    y: primitive.y + object.top - (before.startTop ?? object.top),
    rotation: object.angle,
    scaleX: (primitive.scaleX ?? 1) * object.scaleX / (before.baseScaleX ?? 1) * (object.flipX !== (before.baseFlipX ?? false) ? -1 : 1),
    scaleY: (primitive.scaleY ?? 1) * object.scaleY / (before.baseScaleY ?? 1) * (object.flipY !== (before.baseFlipY ?? false) ? -1 : 1),
  };
  if (primitive.type === "text" && object instanceof IText) updated.text = object.text;
  if (before.svgPrimitiveOffset) {
    const local = fabricPrimitive({ ...updated, x: 0, y: 0 }, style, true, resources);
    updated.x += before.svgPrimitiveOffset.x - local.left;
    updated.y += before.svgPrimitiveOffset.y - local.top;
    local.dispose();
  }
  return updated;
}

export function CanvasEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    element = useRef<HTMLCanvasElement>(null),
    canvas = useRef<Canvas | undefined>(undefined),
    latest = useRef(props),
    sceneId = useRef(""),
    redrawing = useRef(false),
    imageCache = useRef(new Map<string, HTMLImageElement>()),
    resourceSceneId = useRef(""),
    resources = useRef<SvgCanvasResources | undefined>(undefined),
    renderGeneration = useRef(0),
    synchronizingSelection = useRef(false),
    manualProxy = useRef<Rect | undefined>(undefined),
    boxDrag = useRef<{ start: Point; end: Point } | undefined>(undefined),
    [overlays, setOverlays] = useState<{ highlights: { key: string; bounds: GroupBounds; preview: boolean }[]; marquee?: GroupBounds; group?: GroupBounds }>({ highlights: [] }),
    [renderError, setRenderError] = useState(""),
    [zoom, setZoom] = useState(1);
  latest.current = props;
  const screenBounds = (bounds: GroupBounds): GroupBounds => {
    const c = canvas.current!;
    const start = util.transformPoint(new Point(bounds.left, bounds.top), c.viewportTransform);
    const end = util.transformPoint(new Point(bounds.left + bounds.width, bounds.top + bounds.height), c.viewportTransform);
    return { left: start.x, top: start.y, width: end.x - start.x, height: end.y - start.y };
  };
  const refreshOverlays = () => {
    const c = canvas.current, current = latest.current, s = current.scene;
    const highlights = c && s ? current.draftMembers.flatMap(member => {
      const bounds = boundsForMember(c, s, member);
      return bounds ? [{ key: memberKey(member), bounds: screenBounds(bounds), preview: !!current.previewMember && memberKey(current.previewMember) === memberKey(member) }] : [];
    }) : [];
    const drag = boxDrag.current;
    const marquee = c && drag ? screenBounds({ left: Math.min(drag.start.x, drag.end.x), top: Math.min(drag.start.y, drag.end.y),
      width: Math.abs(drag.start.x - drag.end.x), height: Math.abs(drag.start.y - drag.end.y) }) : undefined;
    const group = c && manualProxy.current ? screenBounds(manualProxy.current.getBoundingRect()) : undefined;
    const next = { highlights, marquee, group };
    setOverlays(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  };
  const removeGroupProxy = () => {
    const c = canvas.current, proxy = manualProxy.current;
    if (!c || !proxy) return;
    if (c.getActiveObject() === proxy) c.discardActiveObject();
    c.remove(proxy);
    manualProxy.current = undefined;
    proxy.dispose();
  };
  const installGroupProxy = (id: string) => {
    const c = canvas.current, s = latest.current.scene;
    if (!c || !s) return;
    if (proxyData(manualProxy.current)?.id === id) return manualProxy.current;
    removeGroupProxy();
    const proxy = createManualGroupProxy(c, s, id, latest.current.editable);
    if (proxy) { manualProxy.current = proxy; c.add(proxy); }
    return proxy;
  };
  const syncSelection = () => {
    const c = canvas.current, current = latest.current;
    if (!c) return;
    synchronizingSelection.current = true;
    try {
      if (current.boxSelect || current.groupingReview) {
        removeGroupProxy();
        c.discardActiveObject();
      } else if (current.selection.groupId) {
        const proxy = installGroupProxy(current.selection.groupId);
        if (proxy && c.getActiveObject() !== proxy) c.setActiveObject(proxy);
      } else {
        removeGroupProxy();
        const chosen = fabricObjectTree(c.getObjects()).find(object => {
          const meta = (object as any).atelier as Meta | undefined;
          return current.selection.elementId ? meta?.kind === "primitive" && meta.id === current.selection.elementId && meta.moduleId === current.selection.moduleId
            : !current.focus && meta?.kind === "module" && meta.id === current.selection.moduleId;
        });
        if (chosen && c.getActiveObject() !== chosen) c.setActiveObject(chosen);
      }
    } finally { synchronizingSelection.current = false; }
    c.requestRenderAll();
  };
  const boxPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const c = canvas.current;
    if (!c) return;
    return c.getScenePoint(event.nativeEvent);
  };
  const startBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !latest.current.editable) return;
    const point = boxPointer(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    host.current?.focus({ preventScroll: true });
    boxDrag.current = { start: point, end: point };
    refreshOverlays();
  };
  const moveBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = boxPointer(event);
    if (!point || !boxDrag.current) return;
    boxDrag.current.end = point;
    refreshOverlays();
  };
  const endBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    const c = canvas.current, s = latest.current.scene, point = boxPointer(event), drag = boxDrag.current;
    if (!c || !s || !point || !drag) return;
    boxDrag.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const left = Math.min(drag.start.x, point.x), top = Math.min(drag.start.y, point.y);
    const right = Math.max(drag.start.x, point.x), bottom = Math.max(drag.start.y, point.y);
    const selected = groupCandidates(s, latest.current.focus).filter(member => {
      const bounds = boundsForMember(c, s, member);
      return bounds && bounds.left >= left - .01 && bounds.top >= top - .01 &&
        bounds.left + bounds.width <= right + .01 && bounds.top + bounds.height <= bottom + .01;
    });
    latest.current.onBoxSelect(selected);
    refreshOverlays();
  };
  const editingCanvasText = () => canvas.current?.getActiveObjects().some(object => object instanceof IText && object.isEditing);
  const focusViewport = () => {
    if (!editingCanvasText()) host.current?.focus({ preventScroll: true });
  };
  const panViewport = (event: KeyboardEvent<HTMLDivElement>) => {
    const c = canvas.current, direction = viewDirections[event.key];
    if (!c || !latest.current.scene || !direction || event.defaultPrevented ||
      event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || editingCanvasText()) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='textbox'], [role='combobox'], dialog"))) return;
    event.preventDefault();
    event.stopPropagation();
    // Move the viewpoint in the key's direction, in screen pixels at any zoom.
    const step = event.shiftKey ? 160 : 40;
    c.relativePan(new Point(-direction[0] * step, -direction[1] * step));
    c.requestRenderAll();
  };
  const fit = () => {
    const c = canvas.current,
      s = latest.current.scene;
    if (!c || !s) return;
    const z = Math.min((c.width - 68) / s.width, (c.height - 68) / s.height, 1);
    c.setViewportTransform([
      z,
      0,
      0,
      z,
      (c.width - s.width * z) / 2,
      (c.height - s.height * z) / 2,
    ]);
    setZoom(z);
    c.requestRenderAll();
  };
  useEffect(() => {
    if (!element.current || !host.current) return;
    const c = new Canvas(element.current, {
      backgroundColor: boardBackground(),
      preserveObjectStacking: true,
      selection: true,
      fireRightClick: false,
    });
    canvas.current = c;
    c.on("after:render", refreshOverlays);
    const resize = new ResizeObserver((entries) => {
      const bounds = entries[0].contentRect;
      c.setDimensions({ width: bounds.width, height: bounds.height });
      fit();
    });
    resize.observe(host.current);
    const selected = (event: any) => {
      if (redrawing.current || synchronizingSelection.current || latest.current.boxSelect || latest.current.groupingReview) return;
      const o = event.selected?.[0],
        meta: Meta | undefined = o?.atelier;
      if (!meta) return;
      if (meta.kind === "manual-group") {
        latest.current.onSelect({ groupId: meta.id, kind: "manual-group" });
        return;
      }
      const s = latest.current.scene;
      const nested = new Set(s?.manualGroups?.flatMap(group => group.members.filter(member => member.kind === "group").map(member => member.id)));
      // Locked groups still own their members on the canvas. Only box-select
      // candidates exclude them; a click must not bypass the group lock.
      const group = s?.manualGroups?.find(group => group.moduleId === (latest.current.focus || undefined) && !nested.has(group.id) &&
        objectsForMember(c, s, { kind: "group", id: group.id }).some(object => object === o || o.isDescendantOf(object)));
      if (group) {
        // Select the logical group synchronously, so this first click cannot
        // accidentally start moving just one member of the group.
        synchronizingSelection.current = true;
        try {
          const proxy = installGroupProxy(group.id);
          if (proxy) c.setActiveObject(proxy);
        } finally { synchronizingSelection.current = false; }
        latest.current.onSelect({ groupId: group.id, kind: "manual-group" });
        return;
      }
      latest.current.onSelect({
        moduleId:
          meta.moduleId ?? (meta.kind === "module" ? meta.id : undefined),
        elementId: meta.kind === "primitive" ? meta.id : undefined,
        connectorId: meta.kind.startsWith("connector") ? meta.id : undefined,
        regionId: meta.kind.startsWith("region") ? meta.id : undefined,
        kind: meta.kind,
      });
    };
    c.on("selection:created", selected);
    c.on("selection:updated", selected);
    c.on("selection:cleared", () => {
      if (!redrawing.current && !synchronizingSelection.current) latest.current.onSelect({});
    });
    c.on("mouse:dblclick", (event: any) => {
      const meta: Meta | undefined = event.target?.atelier;
      if (meta?.kind === "module") latest.current.onFocus(meta.id);
    });
    const commit = (event: any) => {
      const o = event.target as FabricObject,
        meta: Meta | undefined = (o as any)?.atelier,
        s = latest.current.scene;
      const manual = proxyData(o);
      if (manual && s && latest.current.editable && !redrawing.current) {
        try { latest.current.onChange(transformManualGroup(s, manual.id, manualGroupTransform(o))); }
        catch (error) { previewManualGroup(o, true); setRenderError(error instanceof Error ? error.message : "组合变换失败。"); c.requestRenderAll(); }
        return;
      }
      if (
        !meta ||
        !s ||
        redrawing.current ||
        !latest.current.editable ||
        meta.primitive?.locked ||
        s.modules.find((m) => m.id === meta.moduleId)?.locked
      )
        return;
      const next = structuredClone(s);
      if (meta.kind === "module") {
        const m = next.modules.find((m) => m.id === meta.id);
        if (m && !m.locked) {
          m.x = o.left + (meta.svgFrameOffset?.x ?? 0) * o.scaleX;
          m.y = o.top + (meta.svgFrameOffset?.y ?? 0) * o.scaleY;
          m.width = (m.contentWidth ?? m.width) * o.scaleX;
          m.height = (m.contentHeight ?? m.height) * o.scaleY;
        }
      }
      if (meta.kind === "region") {
        const r = next.regions.find((r) => r.id === meta.id);
        if (r)
          Object.assign(r, {
            x: o.left,
            y: o.top,
            width: o.width * o.scaleX,
            height: o.height * o.scaleY,
          });
      }
      if (meta.kind === "region-title") {
        const r = next.regions.find((r) => r.id === meta.id);
        if (r) r.title = (o as IText).text;
      }
      if (meta.kind === "connector-label") {
        const e = next.connectors.find((e) => e.id === meta.id);
        if (e) {
          e.label = (o as IText).text;
          e.labelAt = {
            x: (meta.sx ?? 0) + o.left - (meta.startLeft ?? o.left),
            y: (meta.sy ?? 0) + o.top - (meta.startTop ?? o.top),
          };
        }
      }
      if (meta.kind === "primitive" && meta.primitive) {
        const patch = (items: Primitive[]): Primitive[] =>
          items.map((e) => {
            if (e.id !== meta.id)
              return {
                ...e,
                children: e.children ? patch(e.children) : undefined,
              };
            if (e.locked) return e;
            if (meta.svgTree) return svgPrimitiveEdit(e, o, meta, s.style, resources.current);
            const updated = {
              ...e,
              x: e.x + (o.left - (meta.startLeft ?? o.left)) / (meta.sx ?? 1),
              y: e.y + (o.top - (meta.startTop ?? o.top)) / (meta.sy ?? 1),
              rotation: o.angle,
            };
            const rx = o.scaleX / (meta.baseScaleX ?? 1),
              ry = o.scaleY / (meta.baseScaleY ?? 1);
            if (e.type === "text") {
              updated.text = (o as IText).text;
              updated.fontSize = (e.fontSize ?? s.style.bodySize) * rx;
            } else if (["rect", "ellipse", "line"].includes(e.type)) {
              updated.width = (e.width ?? 10) * rx;
              updated.height = (e.height ?? 10) * ry;
            } else {
              updated.scaleX = (e.scaleX ?? 1) * rx;
              updated.scaleY = (e.scaleY ?? 1) * ry;
            }
            if (meta.svgPrimitiveOffset) {
              // Rotating or scaling changes Fabric's outer-bound origin.
              // Store the SVG geometry origin so redrawing preserves the edit.
              const local = fabricPrimitive({ ...updated, x: 0, y: 0 }, s.style, true, resources.current);
              updated.x += meta.svgPrimitiveOffset.x - local.left;
              updated.y += meta.svgPrimitiveOffset.y - local.top;
              local.dispose();
            }
            return updated;
          });
        if (meta.moduleId) {
          const m = next.modules.find((m) => m.id === meta.moduleId);
          if (m) m.elements = patch(m.elements);
        } else next.annotations = patch(next.annotations);
      }
      latest.current.onChange(next);
    };
    c.on("object:modified", commit);
    const preview = (event: any) => { if (proxyData(event.target)) previewManualGroup(event.target); };
    c.on("object:moving", preview);
    c.on("object:scaling", preview);
    c.on("text:editing:exited", commit);
    c.on("mouse:wheel", (event: any) => {
      focusViewport();
      const z = Math.min(
        2.5,
        Math.max(0.15, c.getZoom() * Math.pow(0.999, event.e.deltaY)),
      );
      c.zoomToPoint(c.getViewportPoint(event.e), z);
      setZoom(z);
      event.e.preventDefault();
      event.e.stopPropagation();
    });
    return () => {
      resize.disconnect();
      boxDrag.current = undefined;
      manualProxy.current = undefined;
      canvas.current = undefined;
      void c.dispose();
    };
  }, []);
  useEffect(() => {
    const c = canvas.current,
      s = props.scene;
    if (!c) return;
    const generation = ++renderGeneration.current;
    const controller = new AbortController();
    redrawing.current = true;
    resources.current = undefined;
    setRenderError("");
    const viewport = [...c.viewportTransform];
    removeGroupProxy();
    c.clear();
    c.backgroundColor = boardBackground();
    if (!s) {
      imageCache.current.clear();
      resourceSceneId.current = "";
      sceneId.current = "";
      c.requestRenderAll();
      redrawing.current = false;
      return () => controller.abort();
    }
    if (resourceSceneId.current !== s.id) {
      imageCache.current.clear();
      resourceSceneId.current = s.id;
    }
    const svgScene = s.figureType === "svg-import";
    const draw = (loaded?: SvgCanvasResources) => {
    if (controller.signal.aborted || generation !== renderGeneration.current || canvas.current !== c) return;
    resources.current = loaded;
    // A selected SVG child remains in its compositing group. Multi-selection
    // would reparent it and change clipping and overlapping transparency.
    c.selection = !svgScene && !latest.current.boxSelect && !latest.current.groupingReview;
    c.selectionKey = svgScene || latest.current.selection.groupId ? [] : "shiftKey";
    c.add(
      new Rect({
        left: 0,
        top: 0,
        width: s.width,
        height: s.height,
        fill: "#fff",
        selectable: false,
        evented: false,
        stroke: "#d8dee6",
        strokeWidth: 1,
      }),
    );
    for (const r of s.regions) {
      const editable = props.editable && !props.focus;
      c.add(
        tag(
          new Rect({
            left: r.x,
            top: r.y,
            width: r.width,
            height: r.height,
            rx: 16,
            ry: 16,
            fill: canvasPaint(r.fill),
            stroke: canvasPaint(r.stroke, s.style.muted),
            strokeWidth: 1.5,
            strokeDashArray: r.dash ? [7, 5] : undefined,
            selectable: editable,
            evented: editable,
          }),
          { kind: "region", id: r.id },
        ),
      );
      c.add(
        tag(
          fabricPrimitive(
            {
              id: r.id + "-title",
              type: "text",
              x: r.x + 18,
              y: r.y + 12,
              text: r.title,
              fontSize: s.style.titleSize,
              fontWeight: 700,
            },
            s.style,
            s.figureType === "svg-import",
          ).set({ selectable: editable, evented: editable }),
          { kind: "region-title", id: r.id },
        ),
      );
    }
    const addLeaves = (
      items: Primitive[],
      moduleId: string | undefined,
      offset: { x: number; y: number },
      sx: number,
      sy: number,
    ) => {
      if (svgScene) {
        for (const raw of items) c.add(svgTree(raw, moduleId));
        return;
      }
      for (const raw of items) {
        const e = expandPrimitive(raw);
        if (e.type === "group") {
          addLeaves(
            (e.children ?? []).map((child) => ({
              ...child,
              locked: child.locked || e.locked,
            })),
            moduleId,
            { x: offset.x + e.x * sx, y: offset.y + e.y * sy },
            sx * (e.scaleX ?? 1),
            sy * (e.scaleY ?? 1),
          );
          continue;
        }
        const moduleLocked = s.modules.find((m) => m.id === moduleId)?.locked;
        const canEdit = props.editable && !e.locked && !moduleLocked;
        const o = fabricPrimitive(e, s.style, s.figureType === "svg-import", loaded);
        const svgPrimitiveOffset = s.figureType === "svg-import"
          ? { x: o.left - e.x, y: o.top - e.y }
          : undefined;
        o.set({
          left: offset.x + o.left * sx,
          top: offset.y + o.top * sy,
          scaleX: o.scaleX * sx,
          scaleY: o.scaleY * sy,
          selectable: canEdit,
          evented: true,
          lockMovementX: !canEdit,
          lockMovementY: !canEdit,
          lockScalingX: !canEdit,
          lockScalingY: !canEdit,
          lockRotation: !canEdit,
        });
        if (o instanceof IText) o.editable = canEdit;
        tag(o, {
          kind: "primitive",
          id: e.id,
          moduleId,
          primitive: e,
          startLeft: o.left,
          startTop: o.top,
          sx,
          sy,
          baseScaleX: o.scaleX,
          baseScaleY: o.scaleY,
          svgPrimitiveOffset,
        });
        c.add(o);
      }
    };
    const svgTree = (raw: Primitive, moduleId: string | undefined) => {
      const moduleLocked = s.modules.find(m => m.id === moduleId)?.locked;
      const root = fabricPrimitive(raw, s.style, true, loaded, (object, primitive) => {
        tag(object, {
          kind: "primitive", id: primitive.id, primitive, moduleId, svgTree: true,
          svgPrimitiveOffset: { x: object.left - primitive.x, y: object.top - primitive.y },
        });
      });
      const configure = (object: FabricObject, inheritedLock: boolean) => {
        const meta = (object as any).atelier as Meta | undefined;
        if (!meta) return;
        const locked = inheritedLock || !!meta.primitive?.locked;
        const canEdit = props.editable && !locked;
        object.set({ selectable: canEdit, evented: true, lockMovementX: !canEdit,
          lockMovementY: !canEdit, lockScalingX: !canEdit, lockScalingY: !canEdit, lockRotation: !canEdit });
        if (object instanceof IText) object.editable = canEdit;
        if (object instanceof Group) {
          object.set({ interactive: canEdit, subTargetCheck: canEdit });
          object.getObjects().forEach(child => configure(child, locked));
        }
      };
      configure(root, !!moduleLocked);
      return root;
    };
    addLeaves(s.annotations.filter(e => e.layer === "background"), undefined, { x: 0, y: 0 }, 1, 1);
    for (const edge of s.connectors) {
      const g = connectorGeometry(edge, s);
      if (!g) continue;
      for(const piece of g.pieces??[{path:g.path,color:edge.color}])c.add(
        tag(
          new Path(piece.path, {
            fill: "",
            stroke: canvasPaint(piece.color, s.style.ink),
            strokeWidth: edge.strokeWidth ?? s.style.lineWidth,
            strokeDashArray: edge.dash ? [7, 5] : undefined,
            selectable: props.editable && !props.focus,
            evented: !props.focus,
            hasControls: false,
            lockMovementX: true,
            lockMovementY: true,
            objectCaching: false,
          }),
          { kind: "connector", id: edge.id },
        ),
      );
      const last = g.points.at(-1)!,
        prev = g.points.at(-2) ?? last,
        angle =
          (Math.atan2(last.y - prev.y, last.x - prev.x) * 180) / Math.PI + 90;
      c.add(
        new Triangle({
          left: last.x,
          top: last.y,
          width: 13,
          height: 15,
          fill: edge.curve?.at(-1)?.color??edge.color ?? s.style.ink,
          angle,
          originX: "center",
          originY: "center",
          selectable: false,
          evented: false,
        }),
      );
      if (shouldRenderConnectorLabel(edge,s)) {
        const text = fabricPrimitive(
          {
            id: edge.id + "-label",
            type: "text",
            x: g.label.x - 70,
            y: g.label.y - 17,
            width: 140,
            text: edge.label,
            align: "center",
            fontSize: Math.max(s.style.minimumFontSize??17, s.style.bodySize - 3),
            fill: edge.color ?? s.style.ink,
          },
          s.style,
          s.figureType === "svg-import",
        ).set({
          selectable: props.editable && !props.focus,
          evented: !props.focus,
        });
        c.add(
          tag(text, {
            kind: "connector-label",
            id: edge.id,
            startLeft: text.left,
            startTop: text.top,
            sx: g.label.x,
            sy: g.label.y,
          }),
        );
      }
    }
    for (const m of s.modules) {
      if (m.status !== "ready" && !m.elements.length) {
        c.add(
          new Rect({
            left: m.x,
            top: m.y,
            width: m.width,
            height: m.height,
            fill: "#f4f6fa",
            stroke: m.status === "error" ? "#d7aaa0" : "#d6dde9",
            strokeDashArray: [6, 5],
            selectable: false,
            evented: false,
          }),
        );
        c.add(
          fabricPrimitive(
            {
              id: m.id + "-pending",
              type: "text",
              x: m.x + 16,
              y: m.y + 16,
              width: m.width - 32,
              text:
                m.title +
                "\n" +
                (m.status === "error"
                  ? "模块生成失败 · 可继续重试"
                  : "模块设计中…"),
              fontSize: 22,
              fill: "#929db0",
            },
            s.style,
            s.figureType === "svg-import",
          ).set({ selectable: false, evented: false }),
        );
        continue;
      }
      if (props.focus === m.id && !svgScene) {
        addLeaves(
          m.elements,
          m.id,
          { x: m.x, y: m.y },
          m.width / (m.contentWidth ?? m.width),
          m.height / (m.contentHeight ?? m.height),
        );
        c.add(
          new Rect({
            left: m.x - 5,
            top: m.y - 5,
            width: m.width + 10,
            height: m.height + 10,
            fill: "transparent",
            stroke: "#356dcc",
            strokeWidth: 1.5,
            strokeDashArray: [6, 5],
            selectable: false,
            evented: false,
          }),
        );
        continue;
      }
      const bounds = new Rect({
        left: 0,
        top: 0,
        width: m.contentWidth ?? m.width,
        height: m.contentHeight ?? m.height,
        fill: "transparent",
        strokeWidth: 0,
        selectable: false,
        evented: false,
      });
      const focused = props.focus === m.id;
      const GroupClass = svgScene ? SvgCompositingGroup : Group;
      const group = new GroupClass(
        [bounds, ...m.elements.map((e) => svgScene ? svgTree(e, m.id) : fabricPrimitive(e, s.style, false, loaded))],
        {
          left: m.x,
          top: m.y,
          scaleX: m.width / (m.contentWidth ?? m.width),
          scaleY: m.height / (m.contentHeight ?? m.height),
          selectable: props.editable && !m.locked && !focused,
          evented: true,
          subTargetCheck: svgScene && focused,
          interactive: svgScene && focused,
          ...(svgScene ? { layoutManager: svgGroupLayout(), strokeWidth: 0 } : {}),
          objectCaching: false,
          opacity: props.focus && props.focus !== m.id ? 0.35 : 1,
        },
      );
      group.set({ lockRotation: true });
      group.setControlsVisibility({ mtr: false });
      const svgFrameOffset = s.figureType === "svg-import"
        ? alignSvgModuleFrame(group, bounds, m)
        : undefined;
      tag(group, { kind: "module", id: m.id, moduleId: m.id, svgFrameOffset });
      c.add(group);
      if (svgScene && focused) c.add(new Rect({
        left: m.x - 5, top: m.y - 5, width: m.width + 10, height: m.height + 10,
        fill: "transparent", stroke: "#356dcc", strokeWidth: 1.5, strokeDashArray: [6, 5], selectable: false, evented: false,
      }));
    }
    addLeaves(s.annotations.filter(e => e.layer !== "background"), undefined, { x: 0, y: 0 }, 1, 1);
    if (svgScene) for (const object of fabricObjectTree(c.getObjects())) {
      const meta = (object as any).atelier as Meta | undefined;
      if (meta?.svgTree) Object.assign(meta, { startLeft: object.left, startTop: object.top,
        baseScaleX: object.scaleX, baseScaleY: object.scaleY, baseFlipX: object.flipX, baseFlipY: object.flipY });
    }
    c.setViewportTransform(viewport as any);
    if (sceneId.current !== s.id) {
      sceneId.current = s.id;
      fit();
    }
    syncSelection();
    c.requestRenderAll();
    redrawing.current = false;
    };
    if (svgScene || s.assets) {
      c.requestRenderAll();
      void prepareSvgCanvasResources(s, imageCache.current, controller.signal).then(draw).catch(error => {
        if (controller.signal.aborted || generation !== renderGeneration.current) return;
        redrawing.current = false;
        setRenderError(error instanceof Error ? error.message : "SVG 资源加载失败。");
      });
    } else draw();
    return () => controller.abort();
  }, [props.scene, props.focus, props.editable]);
  useEffect(() => {
    if (!redrawing.current) syncSelection();
  }, [props.selection, props.focus, props.boxSelect, props.groupingReview]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.skipTargetFind = props.boxSelect || !!props.groupingReview;
    c.selection = !props.boxSelect && !props.groupingReview && props.scene?.figureType !== "svg-import";
    c.selectionKey = props.scene?.figureType === "svg-import" || props.selection.groupId ? [] : "shiftKey";
    if (!props.boxSelect) boxDrag.current = undefined;
    refreshOverlays();
  }, [props.boxSelect, props.groupingReview, props.draftMembers, props.previewMember, props.scene, props.selection.groupId]);
  const changeZoom = (factor: number) => {
    const c = canvas.current;
    if (!c) return;
    const z = Math.min(2.5, Math.max(0.15, c.getZoom() * factor));
    c.setZoom(z);
    setZoom(z);
    c.requestRenderAll();
  };
  return (
    <div className="canvas-host" ref={host} tabIndex={0} role="region" aria-label="画布视角"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight"
      onKeyDown={panViewport}
      onPointerDownCapture={event => {
        if (event.target instanceof HTMLCanvasElement) focusViewport();
      }}>
      <canvas ref={element} />
      {props.boxSelect && <div className="canvas-box-selector" aria-label="拖动框选图层"
        onPointerDown={startBox} onPointerMove={moveBox} onPointerUp={endBox}
        onPointerCancel={() => { boxDrag.current = undefined; refreshOverlays(); }} />}
      <div className="canvas-group-overlays" aria-hidden="true">
        {overlays.highlights.map(item => <div key={item.key} className={`canvas-group-highlight${item.preview ? " preview" : ""}`}
          data-group-highlight={item.key} data-preview={item.preview} style={item.bounds} />)}
        {overlays.marquee && <div className="canvas-group-marquee" style={overlays.marquee} />}
        {overlays.group && <div data-testid="manual-group-bounds" style={overlays.group} />}
      </div>
      <div className="canvas-top-note">
        {renderError && <span role="alert">{renderError}</span>}
        {props.focus ? (
          <button onClick={() => props.onFocus("")}>
            <ArrowLeft size={14} /> 返回整图 · 正在编辑模块内部
          </button>
        ) : (
          <span>
            <MousePointer2 size={13} /> 拖动模块 · 双击进入内部 · 滚轮缩放
          </span>
        )}
        <span className="canvas-navigation-hint">点击画布后，方向键移动视角 · Shift 加速</span>
      </div>
      <div className="canvas-zoom">
        <button title="缩小" onClick={() => changeZoom(0.85)}>
          <Minus size={14} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button title="放大" onClick={() => changeZoom(1.18)}>
          <Plus size={14} />
        </button>
        <i />
        <button title="适应画板" onClick={fit}>
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}

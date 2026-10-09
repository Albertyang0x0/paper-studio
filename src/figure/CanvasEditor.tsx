import { useEffect, useRef, useState } from "react";
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
  type FabricObject,
} from "fabric";
import { Maximize2, Minus, Plus, MousePointer2, ArrowLeft } from "lucide-react";
import type { FigureScene, Primitive } from "../../shared/types";
import { connectorGeometry,shouldRenderConnectorLabel } from "../../shared/svg";
import { expandPrimitive } from "../../shared/assets";
import { displayMath } from "../../shared/math-text";
import { canvasPaint } from "../../shared/canvas-paint";

type Selection = {
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
};
const tag = (o: FabricObject, data: Meta) => {
  (o as any).atelier = data;
  return o;
};
const boardBackground = () => getComputedStyle(document.documentElement).getPropertyValue('--ui-bg').trim() || '#181818';
function fabricPrimitive(
  raw: Primitive,
  style: FigureScene["style"],
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
      angle: e.rotation ?? 0,
      originX: "left" as const,
      originY: "top" as const,
      objectCaching: false,
    };
  let o: FabricObject;
  if (e.type === "rect")
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
    const text = new IText(displayMath(e.text ?? ""), {
      ...options,
      fontSize: e.fontSize ?? style.bodySize,
      fontFamily: (e.fontFamily ?? style.font).split(',')[0].trim().replace(/^["']|["']$/g,''),
      fontWeight: e.fontWeight ?? 400,
      fontStyle: e.italic ? "italic" : "normal",
      lineHeight: 1.24,
      textAlign: e.align ?? "left",
      padding: 3,
    });
    // Match the native document contract used by SVG: baseline .92*fontSize,
    // line advance 1.24*fontSize. Fabric otherwise multiplies line height 1.13.
    text._fontSizeMult=1;
    text._fontSizeFraction=.08;
    text.initDimensions();
    o=text;
  }
  else
    o = new Group(
      (e.children ?? []).map((child) => fabricPrimitive(child, style)),
      { ...options, subTargetCheck: false },
    );
  const naturalLeft = o.left,
    naturalTop = o.top;
  const preserveBounds =
    e.type === "path" || e.type === "polygon" || e.type === "group";
  const px = preserveBounds ? naturalLeft * (e.scaleX ?? 1) : 0,
    py = preserveBounds ? naturalTop * (e.scaleY ?? 1) : 0;
  o.set({
    left: e.x + px,
    top: e.y + py,
    scaleX: e.scaleX ?? 1,
    scaleY: e.scaleY ?? 1,
  });
  if (e.type === "text" && e.align === "center")
    o.set("left", e.x + ((e.width ?? 0) - o.width) / 2);
  if (e.type === "text" && e.align === "right")
    o.set("left", e.x + (e.width ?? 0) - o.width);
  return o;
}
export function CanvasEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    element = useRef<HTMLCanvasElement>(null),
    canvas = useRef<Canvas | undefined>(undefined),
    latest = useRef(props),
    sceneId = useRef(""),
    redrawing = useRef(false),
    [zoom, setZoom] = useState(1);
  latest.current = props;
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
    const resize = new ResizeObserver((entries) => {
      const bounds = entries[0].contentRect;
      c.setDimensions({ width: bounds.width, height: bounds.height });
      fit();
    });
    resize.observe(host.current);
    const selected = (event: any) => {
      const o = event.selected?.[0],
        meta: Meta | undefined = o?.atelier;
      if (!meta) return;
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
      if (!redrawing.current) latest.current.onSelect({});
    });
    c.on("mouse:dblclick", (event: any) => {
      const meta: Meta | undefined = event.target?.atelier;
      if (meta?.kind === "module") latest.current.onFocus(meta.id);
    });
    const commit = (event: any) => {
      const o = event.target as FabricObject,
        meta: Meta | undefined = (o as any)?.atelier,
        s = latest.current.scene;
      if (
        !meta ||
        !s ||
        !latest.current.editable ||
        meta.primitive?.locked ||
        s.modules.find((m) => m.id === meta.moduleId)?.locked
      )
        return;
      const next = structuredClone(s);
      if (meta.kind === "module") {
        const m = next.modules.find((m) => m.id === meta.id);
        if (m && !m.locked) {
          m.x = o.left;
          m.y = o.top;
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
    c.on("text:editing:exited", commit);
    c.on("mouse:wheel", (event: any) => {
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
      canvas.current = undefined;
      void c.dispose();
    };
  }, []);
  useEffect(() => {
    const c = canvas.current,
      s = props.scene;
    if (!c) return;
    redrawing.current = true;
    const viewport = [...c.viewportTransform];
    c.clear();
    c.backgroundColor = boardBackground();
    if (!s) {
      c.requestRenderAll();
      redrawing.current = false;
      return;
    }
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
        const o = fabricPrimitive(e, s.style);
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
        });
        c.add(o);
      }
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
          ).set({ selectable: false, evented: false }),
        );
        continue;
      }
      if (props.focus === m.id) {
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
      const group = new Group(
        [bounds, ...m.elements.map((e) => fabricPrimitive(e, s.style))],
        {
          left: m.x,
          top: m.y,
          scaleX: m.width / (m.contentWidth ?? m.width),
          scaleY: m.height / (m.contentHeight ?? m.height),
          selectable: props.editable && !m.locked,
          evented: true,
          subTargetCheck: false,
          objectCaching: false,
          opacity: props.focus && props.focus !== m.id ? 0.35 : 1,
        },
      );
      group.set({ lockRotation: true });
      group.setControlsVisibility({ mtr: false });
      tag(group, { kind: "module", id: m.id, moduleId: m.id });
      c.add(group);
    }
    addLeaves(s.annotations.filter(e => e.layer !== "background"), undefined, { x: 0, y: 0 }, 1, 1);
    c.setViewportTransform(viewport as any);
    if (sceneId.current !== s.id) {
      sceneId.current = s.id;
      fit();
    }
    const selected = c.getObjects().find((o) => {
      const meta: Meta | undefined = (o as any).atelier;
      return props.selection.elementId
        ? meta?.id === props.selection.elementId
        : !props.focus &&
            meta?.kind === "module" &&
            meta.id === props.selection.moduleId;
    });
    if (selected) c.setActiveObject(selected);
    c.requestRenderAll();
    redrawing.current = false;
  }, [props.scene, props.focus, props.editable]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const chosen = c.getObjects().find((o) => {
      const meta: Meta | undefined = (o as any).atelier;
      return props.selection.elementId
        ? meta?.id === props.selection.elementId
        : !props.focus &&
            meta?.kind === "module" &&
            meta.id === props.selection.moduleId;
    });
    if (chosen && c.getActiveObject() !== chosen) {
      c.setActiveObject(chosen);
      c.requestRenderAll();
    }
  }, [props.selection, props.focus]);
  const changeZoom = (factor: number) => {
    const c = canvas.current;
    if (!c) return;
    const z = Math.min(2.5, Math.max(0.15, c.getZoom() * factor));
    c.setZoom(z);
    setZoom(z);
    c.requestRenderAll();
  };
  return (
    <div className="canvas-host" ref={host}>
      <canvas ref={element} />
      <div className="canvas-top-note">
        {props.focus ? (
          <button onClick={() => props.onFocus("")}>
            <ArrowLeft size={14} /> 返回整图 · 正在编辑模块内部
          </button>
        ) : (
          <span>
            <MousePointer2 size={13} /> 拖动模块 · 双击进入内部 · 滚轮缩放
          </span>
        )}
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

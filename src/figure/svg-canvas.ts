import { FabricObject, FixedLayout, Group, LayoutManager, Path, Point, Rect, util } from "fabric";
import type { FigureScene, Primitive } from "../../shared/types";
import { primitiveSvg } from "../../shared/svg";
import { svgUnderlineKey, svgUnderlineMetrics, svgUnderlineProbe, type SvgUnderlineMetrics } from "./svg-text-decoration";

type Box = { x: number; y: number; width: number; height: number };
export type SvgCanvasResources = {
  images: Map<string, HTMLImageElement>;
  shadows: Map<string, { image: HTMLImageElement; box: Box }>;
  underlines?: Map<string, SvgUnderlineMetrics>;
};

const abortError = () => new DOMException("Rendering cancelled", "AbortError");

function decodeImage(source: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const image = new Image();
    const dispose = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => { dispose(); image.src = ""; reject(abortError()); };
    image.onload = () => { dispose(); resolve(image); };
    image.onerror = () => { dispose(); reject(new Error("SVG 图片或局部阴影无法解码。")); };
    signal.addEventListener("abort", cancel, { once: true });
    image.src = source;
  });
}

/** Decode only embedded assets and individual effects; geometry stays native. */
export async function prepareSvgCanvasResources(
  scene: FigureScene,
  cache: Map<string, HTMLImageElement>,
  signal: AbortSignal,
): Promise<SvgCanvasResources> {
  const resources: SvgCanvasResources = { images: new Map(), shadows: new Map(), underlines: new Map() };
  const pending = new Map<string, Promise<HTMLImageElement>>();
  const load = (source: string) => {
    const cached = cache.get(source);
    if (cached) return Promise.resolve(cached);
    let result = pending.get(source);
    if (!result) {
      result = decodeImage(source, signal).then(image => {
        if (signal.aborted) throw abortError();
        // Limit retained effect revisions while preserving the current drawing.
        if (cache.size >= 96) cache.delete(cache.keys().next().value!);
        cache.set(source, image);
        return image;
      });
      pending.set(source, result);
    }
    return result;
  };
  const jobs: Promise<void>[] = [];
  const underlineJobs = new Set<string>();
  const underlineProbes: { key: string; probe: ReturnType<typeof svgUnderlineProbe> }[] = [];
  for (const [id, asset] of Object.entries(scene.assets ?? {})) {
    if (!/^data:image\/(?:png|jpe?g);base64,/i.test(asset.dataUrl)) throw new Error("画板图片必须使用内嵌 PNG 或 JPEG。");
    jobs.push(load(asset.dataUrl).then(image => { resources.images.set(id, image); }));
  }
  const visit = (items: Primitive[]) => {
    for (const primitive of items) {
      if (primitive.type === "text" && primitive.underline) {
        const key = svgUnderlineKey(primitive, scene.style);
        if (!underlineJobs.has(key)) {
          if (underlineJobs.size >= 256) throw new Error("下划线文字的字体样式超过 256 种，请拆分文件。");
          underlineJobs.add(key);
          const probe = svgUnderlineProbe(primitive, scene.style);
          underlineProbes.push({ key, probe });
        }
      }
      if (primitive.svgShadow) {
        const box = primitive.svgShadow.region;
        const density = Math.min(3, 4096 / Math.max(1, box.width), 4096 / Math.max(1, box.height), Math.sqrt(16_000_000 / Math.max(1, box.width * box.height)));
        const local = { ...primitive, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, clip: undefined };
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.ceil(box.width * density))}" height="${Math.max(1, Math.ceil(box.height * density))}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}">${primitiveSvg(local, scene.style, true, scene.assets)}</svg>`;
        jobs.push(load("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)).then(image => {
          resources.shadows.set(primitive.id, { image, box });
        }));
      }
      if (primitive.children) visit(primitive.children);
    }
  };
  visit(scene.annotations);
  for (const module of scene.modules) visit(module.elements);
  // Font probes are tiny and local; bound concurrent decodes across large scenes.
  let nextProbe = 0;
  for (let worker = 0; worker < Math.min(4, underlineProbes.length); worker++) jobs.push((async () => {
    while (nextProbe < underlineProbes.length) {
      const { key, probe } = underlineProbes[nextProbe++], image = await load(probe.source);
      if (signal.aborted) throw abortError();
      const canvas = document.createElement("canvas");
      canvas.width = probe.width; canvas.height = probe.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法测量 SVG 字体下划线。");
      context.drawImage(image, 0, 0);
      resources.underlines!.set(key, svgUnderlineMetrics(context.getImageData(0, 0, probe.width, probe.height).data,
        probe.width, probe.height, probe));
    }
  })());
  await Promise.all(jobs);
  if (signal.aborted) throw abortError();
  return resources;
}

/** Logical dimensions stay in SVG units regardless of decoded pixel density. */
export class SvgRasterObject extends FabricObject {
  constructor(readonly image: HTMLImageElement, width: number, height: number) {
    super({ width, height, strokeWidth: 0, originX: "left", originY: "top", objectCaching: false });
  }
  _render(context: CanvasRenderingContext2D) {
    context.drawImage(this.image, -this.width / 2, -this.height / 2, this.width, this.height);
  }
}

/** A group's opacity is applied once to the composited children. */
export class SvgCompositingGroup extends Group {
  needsItsOwnCache() { return this.opacity !== 1 || super.needsItsOwnCache(); }
}

/** Keep the filter's source children selectable while painting its cached result. */
export class SvgShadowGroup extends SvgCompositingGroup {
  private readonly effectFrame: Rect;
  constructor(children: FabricObject[], readonly image: HTMLImageElement, box: Box, options: ConstructorParameters<typeof Group>[1]) {
    const frame = new Rect({ left: box.x, top: box.y, width: box.width, height: box.height,
      strokeWidth: 0, fill: "transparent", selectable: false, evented: false });
    super([frame, ...children], options);
    this.effectFrame = frame;
  }
  drawObject(context: CanvasRenderingContext2D, _forClipping: boolean | undefined, drawing: Parameters<Group["drawObject"]>[2]) {
    const frame = this.effectFrame;
    context.drawImage(this.image, frame.left, frame.top, frame.width, frame.height);
    this._drawClipPath(context, this.clipPath, drawing);
  }
}

export const svgGroupLayout = () => new LayoutManager(new FixedLayout());

/** Clip paths use SVG local coordinates; Fabric clips use the object's center. */
export function applySvgClips(object: FabricObject, primitive: Primitive) {
  if (!primitive.clip?.length) return;
  const svgOrigin = util.transformPoint(new Point(primitive.x, primitive.y), util.invertTransform(object.calcOwnMatrix()));
  let previous: Path | undefined;
  let parentOrigin = new Point(-svgOrigin.x, -svgOrigin.y);
  for (const clip of primitive.clip) {
    const path = new Path(clip.path, { fill: "black", strokeWidth: 0, fillRule: clip.fillRule ?? "nonzero", objectCaching: true });
    const center = path.getRelativeCenterPoint();
    path.set({ left: path.left - parentOrigin.x, top: path.top - parentOrigin.y });
    if (previous) previous.clipPath = path;
    else object.clipPath = path;
    previous = path;
    parentOrigin = center;
  }
  object.set("dirty", true);
}

export function fabricObjectTree(objects: FabricObject[]): FabricObject[] {
  return objects.flatMap(object => [object, ...(object instanceof Group ? fabricObjectTree(object.getObjects()) : [])]);
}

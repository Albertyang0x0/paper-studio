import type {
  Connector,
  FigureScene,
  Point,
  Primitive,
  SceneModule,
  StyleTokens,
} from "./types";
import { expandPrimitive } from "./assets";
import { displayMath } from "./math-text";
export const escapeXml = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function primitiveSvg(raw: Primitive, style: StyleTokens): string {
  const e = expandPrimitive(raw),
    id = escapeXml(e.id),
    gradientId = "paint-" + id,
    fill = e.gradient ? `url(#${gradientId})` : escapeXml(e.fill ?? (e.type === "text" ? style.ink : "none")),
    stroke = escapeXml(e.stroke ?? "none");
  const paint = e.gradient ? `<defs><linearGradient id="${gradientId}" x1="${e.gradient.x1 * 100}%" y1="${e.gradient.y1 * 100}%" x2="${e.gradient.x2 * 100}%" y2="${e.gradient.y2 * 100}%">${e.gradient.stops.map(stop => `<stop offset="${stop.offset * 100}%" stop-color="${escapeXml(stop.color)}" stop-opacity="${stop.opacity ?? 1}"/>`).join("")}</linearGradient></defs>` : "";
  const common = `data-object-id="${id}" fill="${fill}" stroke="${stroke}" stroke-width="${e.strokeWidth ?? style.lineWidth}" opacity="${e.opacity ?? 1}"${e.dash?.length ? ` stroke-dasharray="${e.dash.join(" ")}"` : ""}`;
  const transform = `translate(${e.x} ${e.y})${e.rotation ? ` rotate(${e.rotation})` : ""}${e.scaleX || e.scaleY ? ` scale(${e.scaleX ?? 1} ${e.scaleY ?? 1})` : ""}`;
  if (e.type === "group")
    return `<g data-object-id="${id}" transform="${transform}">${(e.children ?? []).map((c) => primitiveSvg(c, style)).join("")}</g>`;
  let shape = "";
  if (e.type === "rect")
    shape = `<rect ${common} width="${e.width ?? 10}" height="${e.height ?? 10}" rx="${e.radius ?? 0}"/>`;
  if (e.type === "ellipse")
    shape = `<ellipse ${common} cx="${(e.width ?? 10) / 2}" cy="${(e.height ?? 10) / 2}" rx="${(e.width ?? 10) / 2}" ry="${(e.height ?? 10) / 2}"/>`;
  if (e.type === "path")
    shape = `<path ${common} d="${escapeXml(e.path)}" stroke-linejoin="round" stroke-linecap="round"/>`;
  if (e.type === "polygon")
    shape = `<polygon ${common} points="${(e.points ?? []).map((p) => `${p.x},${p.y}`).join(" ")}"/>`;
  if (e.type === "line")
    shape = `<line ${common} x1="0" y1="0" x2="${e.width ?? 0}" y2="${e.height ?? 0}" stroke-linecap="round"/>`;
  if (e.type === "text") {
    const size = e.fontSize ?? style.bodySize,
      anchor =
        e.align === "center" ? "middle" : e.align === "right" ? "end" : "start",
      x =
        e.align === "center"
          ? (e.width ?? 0) / 2
          : e.align === "right"
            ? (e.width ?? 0)
            : 0;
    shape = `<text ${common} font-family="${escapeXml(e.fontFamily ?? style.font)}" font-size="${size}" font-weight="${e.fontWeight ?? 400}"${e.italic ? ' font-style="italic"' : ""} text-anchor="${anchor}">${displayMath(
      String(e.text ?? ""),
    )
      .split("\n")
      .map(
        (line, i) =>
          `<tspan x="${x}" y="${size * 0.92 + i * size * 1.24}">${escapeXml(line)}</tspan>`,
      )
      .join("")}</text>`;
  }
  return `<g transform="${transform}">${paint}${shape}</g>`;
}
export function connectionPort(
  module: SceneModule,
  name: string | undefined,
  toward: SceneModule,
): Point {
  const side =
    toward.x + toward.width / 2 >= module.x + module.width / 2
      ? "right"
      : "left";
  const port = module.ports.find((p) => p.id === name) ?? { side, offset: 0.5,anchor:undefined };
  if(port.anchor)return {x:module.x+port.anchor.x*module.width,y:module.y+port.anchor.y*module.height};
  const t = Math.max(0, Math.min(1, port.offset));
  return port.side === "top"
    ? { x: module.x + module.width * t, y: module.y }
    : port.side === "bottom"
      ? { x: module.x + module.width * t, y: module.y + module.height }
      : port.side === "left"
        ? { x: module.x, y: module.y + module.height * t }
        : { x: module.x + module.width, y: module.y + module.height * t };
}
type Obstacle = { x: number; y: number; width: number; height: number };
function crossesBox(a: Point, b: Point, box: Obstacle) {
  const inset = 3,
    minX = box.x + inset,
    maxX = box.x + box.width - inset,
    minY = box.y + inset,
    maxY = box.y + box.height - inset;
  let enter = 0,
    leave = 1;
  for (const [start, delta, low, high] of [
    [a.x, b.x - a.x, minX, maxX],
    [a.y, b.y - a.y, minY, maxY],
  ]) {
    if (Math.abs(delta) < 1e-8) {
      if (start <= low || start >= high) return false;
    } else {
      let t1 = (low - start) / delta,
        t2 = (high - start) / delta;
      if (t1 > t2) [t1, t2] = [t2, t1];
      enter = Math.max(enter, t1);
      leave = Math.min(leave, t2);
      if (enter >= leave) return false;
    }
  }
  return enter < leave && leave > 0 && enter < 1;
}
export function orthogonalRoute(
  start: Point,
  end: Point,
  obstacles: Obstacle[],
  bounds: { width: number; height: number },
): Point[] {
  const box = obstacles.map((o) => ({
    x: o.x - 12,
    y: o.y - 12,
    width: o.width + 24,
    height: o.height + 24,
  }));
  const unique = (values: number[]) =>
    [...new Set(values.map((v) => Math.round(v * 10) / 10))].sort(
      (a, b) => a - b,
    );
  const xs = unique(
    [
      start.x,
      end.x,
      (start.x + end.x) / 2,
      12,
      bounds.width - 12,
      ...box.flatMap((o) => [o.x - 6, o.x + o.width + 6]),
    ].filter((x) => x >= 0 && x <= bounds.width),
  );
  const ys = unique(
    [
      start.y,
      end.y,
      (start.y + end.y) / 2,
      12,
      bounds.height - 12,
      ...box.flatMap((o) => [o.y - 6, o.y + o.height + 6]),
    ].filter((y) => y >= 0 && y <= bounds.height),
  );
  const blocked = (a: Point, b: Point) =>
    box.some((o) =>
      a.x === b.x
        ? a.x > o.x &&
          a.x < o.x + o.width &&
          Math.max(a.y, b.y) > o.y &&
          Math.min(a.y, b.y) < o.y + o.height
        : a.y > o.y &&
          a.y < o.y + o.height &&
          Math.max(a.x, b.x) > o.x &&
          Math.min(a.x, b.x) < o.x + o.width,
    );
  const sx = xs.indexOf(Math.round(start.x * 10) / 10),
    sy = ys.indexOf(Math.round(start.y * 10) / 10),
    tx = xs.indexOf(Math.round(end.x * 10) / 10),
    ty = ys.indexOf(Math.round(end.y * 10) / 10);
  if (Math.min(sx, sy, tx, ty) < 0) return [start, end];
  const queue: {
      x: number;
      y: number;
      dir: number;
      cost: number;
      rank: number;
      key: string;
    }[] = [{ x: sx, y: sy, dir: 0, cost: 0, rank: 0, key: `${sx},${sy},0` }],
    costs = new Map<string, number>(),
    previous = new Map<string, string>(),
    coords = new Map<string, Point>();
  costs.set(queue[0].key, 0);
  coords.set(queue[0].key, start);
  let finish = "";
  for (let count = 0; queue.length && count < 12000; count++) {
    queue.sort((a, b) => a.rank - b.rank);
    const cur = queue.shift()!;
    if (cur.cost > (costs.get(cur.key) ?? Infinity)) continue;
    if (cur.x === tx && cur.y === ty) {
      finish = cur.key;
      break;
    }
    for (const [dx, dy, dir] of [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 2],
      [0, -1, 2],
    ]) {
      const x = cur.x + dx,
        y = cur.y + dy;
      if (x < 0 || y < 0 || x >= xs.length || y >= ys.length) continue;
      const a = { x: xs[cur.x], y: ys[cur.y] },
        b = { x: xs[x], y: ys[y] };
      if (blocked(a, b)) continue;
      const cost =
          cur.cost +
          Math.abs(a.x - b.x) +
          Math.abs(a.y - b.y) +
          (cur.dir && cur.dir !== dir ? 28 : 0),
        key = `${x},${y},${dir}`;
      if (cost >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, cost);
      previous.set(key, cur.key);
      coords.set(key, b);
      queue.push({
        x,
        y,
        dir,
        cost,
        rank: cost + Math.abs(b.x - end.x) + Math.abs(b.y - end.y),
        key,
      });
    }
  }
  if (!finish)
    return [
      start,
      { x: (start.x + end.x) / 2, y: start.y },
      { x: (start.x + end.x) / 2, y: end.y },
      end,
    ];
  const points: Point[] = [];
  for (let key = finish; key; key = previous.get(key) ?? "")
    points.unshift(coords.get(key)!);
  return points.filter(
    (p, i) =>
      !i ||
      i === points.length - 1 ||
      ((points[i - 1].x !== p.x || points[i + 1].x !== p.x) &&
        (points[i - 1].y !== p.y || points[i + 1].y !== p.y)),
  );
}
export function connectorGeometry(edge: Connector, scene: FigureScene) {
  const source = scene.modules.find((m) => m.id === edge.from),
    target = scene.modules.find((m) => m.id === edge.to);
  if (!source || !target) return null;
  const start = connectionPort(source, edge.fromPort, target),
    end = connectionPort(target, edge.toPort, source);
  if (edge.curve?.length) {
    const origin = edge.curveAnchors ?? { start, end };
    const shift = (point: Point, t: number): Point => ({
      x: point.x + (start.x - origin.start.x) * (1 - t) + (end.x - origin.end.x) * t,
      y: point.y + (start.y - origin.start.y) * (1 - t) + (end.y - origin.end.y) * t,
    });
    const points: Point[] = [start];
    const pieces:{path:string;color?:string}[]=[];let previous=start;
    let path = `M${start.x} ${start.y}`;
    edge.curve.forEach((part, i) => {
      const c1 = shift(part.c1, (i + 1 / 3) / edge.curve!.length);
      const c2 = shift(part.c2, (i + 2 / 3) / edge.curve!.length);
      const endpoint = i === edge.curve!.length - 1 ? end : shift(part.end, (i + 1) / edge.curve!.length);
      points.push(c1, c2, endpoint);
      pieces.push({path:`M${previous.x} ${previous.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${endpoint.x} ${endpoint.y}`,color:part.color??edge.color});previous=endpoint;
      path += `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${endpoint.x} ${endpoint.y}`;
    });
    return { points, path,pieces, label: edge.labelAt ?? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 12 } };
  }
  const outside = (p: Point, m: SceneModule) => {
    if (Math.abs(p.x - m.x) < 0.1) return { x: p.x - 20, y: p.y };
    if (Math.abs(p.x - m.x - m.width) < 0.1) return { x: p.x + 20, y: p.y };
    if (Math.abs(p.y - m.y) < 0.1) return { x: p.x, y: p.y - 20 };
    return { x: p.x, y: p.y + 20 };
  };
  const annotations = scene.annotations
    .filter((e) => e.type === "text")
    .map((e) => {
      const font = e.fontSize ?? scene.style.bodySize,
        lines = String(e.text ?? "").split("\n");
      return {
        x: e.x,
        y: e.y,
        width: Math.min(
          e.width ?? Infinity,
          Math.max(...lines.map((l) => displayMath(l).length)) * font * 0.55,
        ),
        height: lines.length * font * 1.24,
      };
    });
  const headers = scene.regions.map((r) => ({
    x: r.x + 18,
    y: r.y + 12,
    width: r.title.length * scene.style.titleSize * 0.55,
    height: scene.style.titleSize * 1.24,
  }));
  const obstacles = [...scene.modules, ...annotations, ...headers],
    manual = edge.via?.length ? [start, ...edge.via, end] : undefined;
  const unsafe = manual?.some(
    (p, i) =>
      i > 0 && obstacles.some((box) => crossesBox(manual[i - 1], p, box)),
  );
  const points =
    manual && !unsafe
      ? manual
      : [
          start,
          ...orthogonalRoute(
            outside(start, source),
            outside(end, target),
            obstacles,
            scene,
          ),
          end,
        ];
  let label = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 12 },
    longest = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = Math.hypot(a.x - b.x, a.y - b.y);
    if (length > longest) {
      longest = length;
      label = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 12 };
    }
  }
  return { points, path: roundedPath(points),pieces:undefined, label: edge.labelAt ?? label };
}
// A module owns labels already drawn inside its subfigure. Keep edge metadata
// intact, but do not draw the identical relationship label twice at the seam.
export function shouldRenderConnectorLabel(edge:Connector,scene:FigureScene){
  if(!edge.label)return false;
  const normalize=(text:string)=>text.replace(/\s+/g,' ').trim().toLowerCase();
  const label=normalize(edge.label);
  for(const module of scene.modules.filter(m=>m.id===edge.from||m.id===edge.to)){
    const texts=allPrimitives(module.elements).filter(e=>e.type==='text'&&e.opacity!==0).map(e=>normalize(e.text??''));
    if(texts.some((text,i)=>text===label||(text+' '+(texts[i+1]??''))===label))return false;
  }
  return true;
}
export function roundedPath(points: Point[], radius = 10) {
  if (!points.length) return "";
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1],
      r1 = Math.min(radius, Math.hypot(a.x - b.x, a.y - b.y) / 2),
      r2 = Math.min(radius, Math.hypot(c.x - b.x, c.y - b.y) / 2),
      l1 = Math.hypot(a.x - b.x, a.y - b.y) || 1,
      l2 = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    d += `L${b.x + ((a.x - b.x) * r1) / l1} ${b.y + ((a.y - b.y) * r1) / l1}Q${b.x} ${b.y} ${b.x + ((c.x - b.x) * r2) / l2} ${b.y + ((c.y - b.y) * r2) / l2}`;
  }
  const end = points.at(-1)!;
  return d + `L${end.x} ${end.y}`;
}
export function sceneSvg(scene: FigureScene, metadata = true) {
  const s = scene.style;
  const defs = scene.connectors
    .map(
      (e, i) =>
        `<marker id="arrow${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="${escapeXml(e.curve?.at(-1)?.color??e.color ?? s.ink)}"/></marker>`,
    )
    .join("");
  const regions = scene.regions
    .map(
      (r) =>
        `<g data-region-id="${escapeXml(r.id)}"><rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="16" fill="${escapeXml(r.fill)}" stroke="${escapeXml(r.stroke ?? s.muted)}" stroke-width="1.5"${r.dash ? ' stroke-dasharray="7 5"' : ""}/>${primitiveSvg({ id: r.id + "-title", type: "text", x: r.x + 18, y: r.y + 12, text: r.title, fontSize: s.titleSize, fontWeight: 700 }, s)}</g>`,
    )
    .join("");
  const edges = scene.connectors
    .map((e, i) => {
      const g = connectorGeometry(e, scene);
      if (!g) return "";
      const paths=(g.pieces??[{path:g.path,color:e.color}]).map((p,index,array)=>`<path d="${p.path}" fill="none" stroke="${escapeXml(p.color??s.ink)}" stroke-width="${e.strokeWidth ?? s.lineWidth}"${e.dash?' stroke-dasharray="7 5"':''} stroke-linecap="round"${index===array.length-1?` marker-end="url(#arrow${i})"`:''}/>`).join('');
      return `<g data-connector-id="${escapeXml(e.id)}">${paths}${shouldRenderConnectorLabel(e,scene) ? primitiveSvg({ id: e.id + "-label", type: "text", x: g.label.x - 70, y: g.label.y - 17, width: 140, text: e.label, align: "center", fill: e.color ?? s.ink, fontSize: Math.max(s.minimumFontSize??17, s.bodySize - 3) }, s) : ""}</g>`;
    })
    .join("");
  const modules = scene.modules
    .map(
      (m) =>
        `<g data-module-id="${escapeXml(m.id)}" transform="translate(${m.x} ${m.y}) scale(${m.width / (m.contentWidth ?? m.width)} ${m.height / (m.contentHeight ?? m.height)})">${m.elements.map((e) => primitiveSvg(e, s)).join("")}</g>`,
    )
    .join("");
  const backgrounds = scene.annotations.filter(e => e.layer === "background").map(e => primitiveSvg(e, s)).join("");
  const foregrounds = scene.annotations.filter(e => e.layer !== "background").map(e => primitiveSvg(e, s)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}"><title>${escapeXml(scene.title)}</title>${metadata ? `<metadata>${escapeXml(JSON.stringify(scene))}</metadata>` : ""}<defs>${defs}</defs><rect width="100%" height="100%" fill="#ffffff"/>${regions}${backgrounds}${edges}${modules}${foregrounds}</svg>`;
}
export function allPrimitives(elements: Primitive[]): Primitive[] {
  return elements.flatMap((e) => [e, ...allPrimitives(e.children ?? [])]);
}
export function patchPrimitive(
  elements: Primitive[],
  id: string,
  patch: Partial<Primitive>,
): Primitive[] {
  return elements.map((e) =>
    e.id === id
      ? { ...e, ...patch }
      : {
          ...e,
          children: e.children
            ? patchPrimitive(e.children, id, patch)
            : undefined,
        },
  );
}

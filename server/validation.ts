import type {
  DesignPlan,
  FigureScene,
  Primitive,
  SceneModule,
  SemanticPlan,
} from "../shared/types";
import { expandPrimitive, symbolNames } from "../shared/assets";
import { allPrimitives } from "../shared/svg";
import { displayMath } from "../shared/math-text";
import { textBoxes, textCollisions } from "./typography";
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
export function validateSemantic(plan: SemanticPlan, filenames: Set<string>) {
  if (
    !plan?.title ||
    !Array.isArray(plan.components) ||
    plan.components.length < 2
  )
    throw Error("Semantic planner returned no usable content plan");
  const ids = new Set(plan.components.map((c) => c.id));
  if (ids.size !== plan.components.length)
    throw Error("Duplicate semantic component ids");
  for (const c of plan.components)
    if (!c.sourceRefs?.length || c.sourceRefs.some((r) => !filenames.has(r)))
      throw Error(`Unsupported source reference in ${c.id}`);
  for (const e of plan.relationships ?? [])
    if (!ids.has(e.from) || !ids.has(e.to))
      throw Error("Semantic relationship has missing endpoint");
}
export function validateDesign(design: DesignPlan, semantic: SemanticPlan) {
  if (
    !finite(design.width) ||
    !finite(design.height) ||
    design.width < 800 ||
    design.width > 2400 ||
    design.height < 350 ||
    design.height > 1800
  )
    throw Error("Art director returned invalid canvas dimensions");
  if (
    !design.style?.font ||
    !design.modules?.length ||
    design.modules.length > 8
  )
    throw Error(
      "Art director returned invalid style or module count; prefer 3-6 substantial subfigures, with a maximum of 8",
    );
  const ids = new Set(design.modules.map((m) => m.id));
  if (ids.size !== design.modules.length) throw Error("Duplicate module ids");
  const assigned = new Set([...design.modules.flatMap((m) => m.componentIds ?? []),
    ...allPrimitives(design.annotations??[]).flatMap(e=>e.componentIds??[])]);
  const known = new Set(semantic.components.map((c) => c.id));
  for (const id of assigned)
    if (!known.has(id)) throw Error(`Unknown semantic component ${id}`);
  for (const c of semantic.components)
    if (!assigned.has(c.id))
      throw Error(`Art director omitted semantic component ${c.id}`);
  for (const m of design.modules) {
    if (
      ![m.x, m.y, m.width, m.height].every(finite) ||
      m.width < 100 ||
      m.height < 80 ||
      m.x < 0 ||
      m.y < 0 ||
      m.x + m.width > design.width + 1 ||
      m.y + m.height > design.height + 1
    )
      throw Error(`Invalid occupied-space contract for ${m.id}`);
    const aliases: Record<string, SceneModule["role"]> = {
      mechanism: "structure",
      diagram: "structure",
      architecture: "structure",
      flowchart: "structure",
      data: "plot",
      chart: "plot",
      pictogram: "illustration",
    };
    if (aliases[m.role]) m.role = aliases[m.role];
    if (!["illustration", "structure", "plot"].includes(m.role))
      throw Error(
        `Unknown specialist role ${m.role}; the only accepted values are illustration, structure, plot`,
      );
    m.ports ??= [];
    m.labels ??= [];
    m.sourceRefs ??= [];
  }
  for (let i = 0; i < design.modules.length; i++) {
    for (let j = i + 1; j < design.modules.length; j++) {
      const a = design.modules[i],
        b = design.modules[j];
      if (
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2
      )
        throw Error(
          `Module contracts overlap: ${a.id} and ${b.id}; reserve separate occupied spaces and connector channels`,
        );
    }
  }
  design.regions ??= [];
  design.connectors ??= [];
  design.annotations ??= [];
  design.regions = design.regions.map((r) => ({
    ...r,
    dash: Array.isArray(r.dash) ? r.dash.length > 0 : !!r.dash,
  }));
  for (const e of design.connectors)
    if (!ids.has(e.from) || !ids.has(e.to))
      throw Error(`Connector ${e.id} references a missing module`);
  const palette = design.style.palette?.length
    ? design.style.palette
    : ["#DBEAF2", "#F6E4D3", "#E0EEDD"];
  design.style.palette = palette;
  design.style.bodySize = Math.max(20, Number(design.style.bodySize) || 24);
  design.style.titleSize = Math.max(24, Number(design.style.titleSize) || 28);
  design.style.lineWidth = Math.max(
    1,
    Math.min(4, Number(design.style.lineWidth) || 2),
  );
  design.annotations = design.annotations.length
    ? normalizeElements(
        design.annotations,
        {
          id: "annotations",
          width: design.width,
          height: design.height,
          labels: [],
        },
        false,
      )
    : [];
}
export function normalizeElements(
  raw: unknown,
  module:
    | SceneModule
    | { id: string; width: number; height: number; labels: string[] },
  substantive = true,
): Primitive[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 220)
    throw Error(
      `Specialist ${module.id} returned no substantive vector module`,
    );
  const ids = new Set<string>();
  let count = 0;
  const walk = (e: any): Primitive => {
    e = { ...e };
    // SVG-local coordinates default to the origin; paths may encode their
    // complete position in d, and container groups need no translation.
    e.x ??= 0;
    e.y ??= 0;
    if(e.type==='line' && Array.isArray(e.points) && e.points.length===2) {
      e.x=e.points[0].x;e.y=e.points[0].y;e.width=e.points[1].x-e.x;e.height=e.points[1].y-e.y;delete e.points;
    }
    const paintNames:Record<string,string>={transparent:'none',white:'#ffffff',black:'#000000',gray:'#808080',grey:'#808080'};
    for(const key of ['fill','stroke'])if(typeof e[key]==='string' && paintNames[e[key].toLowerCase()])e[key]=paintNames[e[key].toLowerCase()];
    for (const key of [
      "x",
      "y",
      "width",
      "height",
      "fontSize",
      "size",
      "strokeWidth",
      "scaleX",
      "scaleY",
      "opacity",
      "rotation",
    ])
      if (typeof e[key] === "string" && /^-?\d+(\.\d+)?(?:px)?$/.test(e[key]))
        e[key] = parseFloat(e[key]);
    if (e.type === "icon") {
      e.type = "symbol";
      e.symbol = e.icon;
      e.width ??= e.size;
      e.height ??= e.size;
    }
    if (e.type === "text") {
      e.text ??= e.content ?? e.label;
      e.fontSize ??= e.size ?? 24;
      e.fill ??= e.color;
      if (e.style === "bold") e.fontWeight = 700;
      if (e.style === "italic") e.italic = true;
      if(e.fontWeight==='bold')e.fontWeight=700;
      if(e.fontWeight==='normal')e.fontWeight=400;
      if(typeof e.fontWeight==='string'&&/^\d+$/.test(e.fontWeight))e.fontWeight=Number(e.fontWeight);
    }
    if (++count > 400)
      throw Error(`Module ${module.id} exceeded object budget`);
    if (
      ![
        "rect",
        "ellipse",
        "text",
        "path",
        "line",
        "polygon",
        "group",
        "symbol",
      ].includes(e?.type)
    )
      throw Error(`Unsupported object type in ${module.id}`);
    if (!finite(e.x) || !finite(e.y))
      throw Error(
        `Non-finite coordinate in ${module.id}: ${JSON.stringify({ id: e.id, type: e.type, x: e.x, y: e.y })}`,
      );
    for (const key of [
      "width",
      "height",
      "fontSize",
      "strokeWidth",
      "scaleX",
      "scaleY",
      "opacity",
      "rotation",
    ])
      if (e[key] !== undefined && !finite(e[key]))
        throw Error(`Non-finite ${key} in ${module.id}`);
    if((e.strokeWidth!==undefined && e.strokeWidth<0)||(e.type==='text'&&e.fontSize<=0))throw Error(`Invalid visible dimensions in ${module.id}`);
    if(e.type==='polygon' && (!Array.isArray(e.points)||e.points.length<3||e.points.some((p:any)=>!p||![p.x,p.y].every(finite))))throw Error(`Invalid native polygon in ${module.id}`);
    if (
      ["rect", "ellipse", "symbol"].includes(e.type) &&
      (!(e.width > 0) || !(e.height > 0))
    )
      throw Error(`Invalid shape dimensions in ${module.id}`);
    const id = String(e.id || `object-${count}`);
    if (ids.has(id)) throw Error(`Duplicate object id ${id}`);
    ids.add(id);
    if (
      e.type === "text" &&
      (typeof e.text !== "string" || !finite(e.fontSize))
    )
      throw Error(`Invalid editable text in ${module.id}`);
    if (
      e.type === "path" &&
      (typeof e.path !== "string" ||
        e.path.length > 12000 ||
        !/^[\d\s.,+\-eEaAcChHlLmMqQsStTvVzZ]+$/.test(e.path))
    )
      throw Error(`Invalid vector path in ${module.id}`);
    if (e.type === "symbol" && !symbolNames.includes(e.symbol))
      throw Error(`Unknown vector symbol ${e.symbol}`);
    if (e.gradient && (e.gradient.type !== "linear" ||
      ![e.gradient.x1, e.gradient.y1, e.gradient.x2, e.gradient.y2].every(finite) ||
      !Array.isArray(e.gradient.stops) || e.gradient.stops.length < 2 || e.gradient.stops.length > 8 ||
      e.gradient.stops.some((stop: any) => !finite(stop.offset) || stop.offset < 0 || stop.offset > 1 ||
        !/^#[\da-f]{3,8}$/i.test(stop.color) || (stop.opacity !== undefined && (!finite(stop.opacity) || stop.opacity < 0 || stop.opacity > 1)))))
      throw Error(`Invalid native gradient in ${module.id}`);
    if(e.dash!==undefined&&(!Array.isArray(e.dash)||e.dash.length>16||e.dash.some((n:any)=>!finite(n)||n<0)))throw Error(`Invalid native dash in ${module.id}`);
    const out: Primitive = { ...e, id };
    if (e.children) out.children = e.children.map(walk);
    return expandPrimitive(out);
  };
  const norm = (text: string) =>
    displayMath(text)
      .replace(/[⋯…]/g, "...")
      .replace(/·{3}/g, "...")
      .replace(/[?!]/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  const elements = raw.map(walk),
    texts = norm(
      allPrimitives(elements)
        .filter((e) => e.type === "text")
        .map((e) => e.text ?? "")
        .join(" "),
    );
  if (substantive && allPrimitives(elements).length < 3)
    throw Error(
      `Specialist ${module.id} returned no substantive vector module`,
    );
  for (const label of module.labels) {
    // A relationship glyph is geometry, not necessarily part of a text run.
    // The parent owns external arrows, so require its local source label only.
    const local = label.split(/[→⇒]/)[0].trim();
    const comparable = (s: string) =>
      norm(s).replace(/[=\/]/g, " ").replace(/\s+/g, " ");
    if (!comparable(texts).includes(comparable(local)))
      throw Error(`Specialist omitted required editable label: ${label}`);
  }
  return elements;
}
export function structuralIssues(scene: FigureScene, includeTypography = true) {
  const issues: {
    moduleId?: string;
    elementId?: string;
    severity: "low" | "medium" | "high";
    message: string;
  }[] = [];
  for (const m of scene.modules) {
    if (
      m.x < 0 ||
      m.y < 0 ||
      m.x + m.width > scene.width + 1 ||
      m.y + m.height > scene.height + 1
    )
      issues.push({
        moduleId: m.id,
        severity: "high",
        message: "Module crosses canvas boundary",
      });
    if (!includeTypography) continue;
    const warned = new Set<string>();
    for (const e of textBoxes(m.elements, scene.style))
      if (
        !warned.has(e.id) &&
        (((e.effectiveFontSize * m.height) / (m.contentHeight ?? m.height)) *
          (scene.publicationWidthPt??486)) /
          scene.width <
          7
      ) {
        warned.add(e.id);
        issues.push({
          moduleId: m.id,
          elementId: e.id,
          severity: "medium",
          message:
            `Text will be below 7pt at the specified ${(scene.publicationWidthPt??486)/72}in print width; increase size or simplify`,
        });
      }
    for (const message of textCollisions(m.elements, scene.style))
      issues.push({
        moduleId: m.id,
        severity: "high",
        message: `Measured glyph collision: ${message}`,
      });
  }
  for (let i = 0; i < scene.modules.length; i++)
    for (let j = i + 1; j < scene.modules.length; j++) {
      const a = scene.modules[i],
        b = scene.modules[j];
      if(a.allowOverlapWith?.includes(b.id)||b.allowOverlapWith?.includes(a.id))continue;
      if (
        a.x < b.x + b.width - 2 &&
        a.x + a.width > b.x + 2 &&
        a.y < b.y + b.height - 2 &&
        a.y + a.height > b.y + 2
      )
        issues.push({
          moduleId: a.id,
          severity: "high",
          message: `Occupied region overlaps ${b.id}`,
        });
    }
  return issues;
}

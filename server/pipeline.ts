import { randomUUID } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import type {
  Connector,
  DesignPlan,
  FigureScene,
  ModuleBrief,
  RunInput,
  RunRecord,
  SceneModule,
  SemanticPlan,
} from "../shared/types";
import { allPrimitives, sceneSvg } from "../shared/svg";
import {
  groundingPrompt,
  directorPrompt,
  workerPrompt,
  assemblerPrompt,
  criticPrompt,
} from "./prompts";
import { modelJson, boundModel, referenceImages, type Log } from "./model";
import {
  normalizeElements,
  structuralIssues,
  validateDesign,
  validateSemantic,
} from "./validation";
import { renderedBounds } from "./bounds";
import { fitModuleText } from "./text-layout";
import { preserveLockedObjects } from "../shared/locks";
import { settleGlobalLayout } from "./layout";
import { textCollisions } from "./typography";
import { validatePlanningCheckpoint } from "./checkpoints";
import { generateVisualReconstruction } from "./visual/reconstruction";

export function pngForScene(scene: FigureScene) {
  return new Resvg(sceneSvg(scene, false), {
    fitTo: { mode: "width", value: Math.min(1800, scene.width) },
    font: { loadSystemFonts: true, defaultFontFamily: scene.style.font },
  })
    .render()
    .asPng();
}
async function specialize(
  brief: ModuleBrief,
  input: RunInput,
  style: FigureScene["style"],
  signal: AbortSignal,
  log: Log,
  instruction?: string,
  existing?: SceneModule,
  onDraft?: (draft: unknown) => void,
  savedDraft?: unknown,
): Promise<SceneModule> {
  const method = input.config.methods[brief.role],
    stage = `worker:${brief.id}`;
  log(stage, "running", `${brief.title} · ${brief.role} · ${method}`);
  const data = {
    task: brief,
    style,
    minimumReadableFontSize: style.bodySize,
    materials: input.materials.filter((m) => brief.sourceRefs.includes(m.name)),
    instruction,
    existingElements: existing?.elements,
    lockedObjects: existing
      ? allPrimitives(existing.elements).filter((e) => e.locked)
      : [],
  };
  let result: any,
    elements: SceneModule["elements"] = [],
    lastError: unknown,
    contentWidth = brief.width,
    contentHeight = brief.height,
    validDraft:
      | { elements: SceneModule["elements"]; width: number; height: number }
      | undefined;
  const references = await referenceImages(input.references);
  for (let attempt = 0; attempt < 2; attempt++) {
    const images = [...references];
    if (attempt && validDraft) {
      const local: FigureScene = {
        schema: "paper-atelier/1",
        id: brief.id,
        title: brief.title,
        width: validDraft.width,
        height: validDraft.height,
        style,
        regions: [],
        connectors: [],
        annotations: [],
        modules: [
          {
            ...brief,
            x: 0,
            y: 0,
            width: validDraft.width,
            height: validDraft.height,
            contentWidth: validDraft.width,
            contentHeight: validDraft.height,
            elements: validDraft.elements,
            method,
            status: "ready",
          },
        ],
      };
      images.push(
        `data:image/png;base64,${pngForScene(local).toString("base64")}`,
      );
    }
    try {
      if (!attempt && savedDraft) {
        result = structuredClone(savedDraft);
        log(
          stage,
          "complete",
          "Recompiling the saved real-model vector draft against the corrected contract",
        );
      } else
        result = await boundModel(input.config.connections?.worker, modelJson)(input.config.worker,
          workerPrompt(brief.role, method),
          {
            ...data,
            previousDraft: attempt ? result : undefined,
            validationFeedback: attempt ? String(lastError) : undefined,
          },
          images,
          signal,
          11000,
        );
    } catch (e) {
      if (!validDraft) throw e;
      elements = validDraft.elements;
      contentWidth = validDraft.width;
      contentHeight = validDraft.height;
      log(
        stage,
        "warning",
        `Visual refinement unavailable; retained the previous valid vector draft: ${String(e)}`,
      );
      lastError = undefined;
      break;
    }
    onDraft?.(result);
    try {
      elements = fitModuleText(
        normalizeElements(result.elements, brief),
        brief.width,
        brief.height,
        style,
      );
      const bounds = renderedBounds(elements, brief.width, brief.height, style);
      if (!bounds) throw Error("Module rendered no visible content");
      if (
        bounds.x < -4 ||
        bounds.y < -4 ||
        bounds.right > brief.width + 4 ||
        bounds.bottom > brief.height + 4
      ) {
        const scale = Math.min(
          (brief.width - 2) / bounds.width,
          (brief.height - 2) / bounds.height,
          1,
        );
        if (scale < 0.82) {
          if (
            existing ||
            bounds.width > brief.width * 1.5 ||
            bounds.height > brief.height * 1.5
          )
            throw Error(
              `Rendered objects exceed the local canvas: ${JSON.stringify(bounds)}. Redesign into ${brief.width} × ${brief.height}; reflow content rather than shrinking fonts.`,
            );
          const dx = Math.max(0, 2 - bounds.x),
            dy = Math.max(0, 2 - bounds.y);
          elements = [
            {
              id: brief.id + "-fit-frame",
              type: "group",
              x: dx,
              y: dy,
              children: elements,
            },
          ];
          contentWidth = Math.max(brief.width, bounds.right + dx + 3);
          contentHeight = Math.max(brief.height, bounds.bottom + dy + 3);
          log(
            stage,
            "warning",
            `Expanded intrinsic canvas to ${contentWidth} × ${contentHeight} to preserve readable type; assembler must reflow the module`,
          );
        } else {
          elements = [
            {
              id: brief.id + "-fit-frame",
              type: "group",
              x: 1 - bounds.x * scale,
              y: 1 - bounds.y * scale,
              scaleX: scale,
              scaleY: scale,
              children: elements,
            },
          ];
          log(
            stage,
            "warning",
            `Vector layout compiler fitted minor overflow uniformly (${Math.round(scale * 100)}%); no content was cropped`,
          );
        }
      }
      const collisions = textCollisions(elements, style);
      if (collisions.length) {
        log(
          stage,
          "warning",
          `Measured text collisions: ${collisions.slice(0, 8).join("; ")}`,
        );
        if (!attempt) {
          validDraft = {
            elements: structuredClone(elements),
            width: contentWidth,
            height: contentHeight,
          };
          lastError = Error(
            `Fix these actual glyph collisions without removing required content: ${collisions.slice(0, 12).join("; ")}. The last attached image is YOUR local rendered draft, not a style reference. Reflow objects and leave spacing.`,
          );
          continue;
        }
      }
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
      log(stage, "warning", String(e));
    }
  }
  if (lastError) {
    if (!validDraft) throw lastError;
    elements = validDraft.elements;
    contentWidth = validDraft.width;
    contentHeight = validDraft.height;
    log(
      stage,
      "warning",
      `Refinement did not satisfy the module contract; kept the preceding valid draft for manual revision: ${String(lastError)}`,
    );
  }
  if (existing) elements = preserveLockedObjects(existing.elements, elements);
  const module: SceneModule = {
    ...brief,
    width: contentWidth,
    height: contentHeight,
    method,
    elements,
    status: "ready",
    model: input.config.worker,
    generation: String(result.notes ?? ""),
    contentWidth,
    contentHeight,
  };
  log(
    stage,
    "complete",
    `${brief.title}: ${allPrimitives(elements).length} editable vector objects`,
  );
  return module;
}
async function assemble(
  scene: FigureScene,
  input: RunInput,
  signal: AbortSignal,
  log: Log,
  instruction?: string,
) {
  log(
    "assembler",
    "running",
    "Arrange completed subfigures and route cross-module connections",
  );
  const measured = scene.modules.map((m) => ({
    id: m.id,
    title: m.title,
    x: m.x,
    y: m.y,
    width: m.width,
    height: m.height,
    renderedLocalBounds: renderedBounds(
      m.elements,
      m.contentWidth ?? m.width,
      m.contentHeight ?? m.height,
      scene.style,
    ),
    ports: m.ports,
    objects: allPrimitives(m.elements).length,
    labels: allPrimitives(m.elements)
      .filter((e) => e.type === "text")
      .map((e) => ({
        text: e.text,
        x: e.x,
        y: e.y,
        width: e.width,
        fontSize: e.fontSize,
      })),
    locked: m.locked,
  }));
  const result = await boundModel(input.config.connections?.assembler, modelJson)(input.config.assembler,
    assemblerPrompt,
    {
      canvas: { width: scene.width, height: scene.height },
      style: scene.style,
      regions: scene.regions,
      modules: measured,
      connectors: scene.connectors,
      annotations: scene.annotations,
      instruction,
    },
    [`data:image/png;base64,${pngForScene(scene).toString("base64")}`],
    signal,
    5500,
  );
  if (!Array.isArray(result.placements) || !Array.isArray(result.connectors))
    throw Error("Assembler returned no valid placement or connection plan");
  let next = structuredClone(scene);
  for (const p of result.placements) {
    const m = next.modules.find((m) => m.id === p.id);
    if (!m || m.locked) continue;
    if (![p.x, p.y, p.width, p.height].every((v) => Number.isFinite(v)))
      throw Error("Assembler returned non-finite geometry");
    if (
      p.width < m.width * 0.7 ||
      p.height < m.height * 0.7 ||
      p.width > m.width * 1.3 ||
      p.height > m.height * 1.3
    )
      throw Error(`Assembler exceeded resize allowance for ${m.id}`);
    Object.assign(m, { x: p.x, y: p.y, width: p.width, height: p.height });
  }
  for (const p of result.annotationPositions ?? []) {
    const e = next.annotations.find((e) => e.id === p.id);
    if (e && !e.locked && [p.x, p.y].every(Number.isFinite)) {
      e.x = p.x;
      e.y = p.y;
      if (Number.isFinite(p.width)) e.width = p.width;
    }
  }
  const connectors: Connector[] = result.connectors;
  for (const previous of scene.connectors) {
    const updated = connectors.find((e) => e.id === previous.id);
    if (
      !updated ||
      updated.from !== previous.from ||
      updated.to !== previous.to ||
      updated.label !== previous.label
    )
      throw Error(`Assembler altered semantic relationship ${previous.id}`);
  }
  if (connectors.length !== scene.connectors.length)
    throw Error("Assembler added an unsupported semantic relationship");
  next.connectors = connectors;
  next = settleGlobalLayout(next);
  // Composition can correct global geometry, not the contents of child modules.
  // Local typography belongs in the independent review/targeted repair stage.
  const faults = structuralIssues(next, false).filter(
    (i) => i.severity === "high",
  );
  if (faults.length)
    throw Error(
      `Assembler layout is invalid: ${faults.map((f) => f.message).join("; ")}`,
    );
  log("assembler", "complete", String(result.notes ?? "Subfigures assembled"));
  return next;
}
export async function reviewSceneDocument(
  scene: FigureScene,
  input: RunInput,
  signal: AbortSignal,
  log: Log,
) {
  log(
    "critic",
    "running",
    "Inspect actual SVG rendering and source-grounded object document",
  );
  const preview = `data:image/png;base64,${pngForScene(scene).toString("base64")}`;
  try {
    const result = await boundModel(input.config.connections?.critic, modelJson)(input.config.critic,
      criticPrompt,
      { scene, materials: input.materials, intent: input.intent },
      [preview],
      signal,
      6500,
    );
    const issues = [
      ...structuralIssues(scene),
      ...(Array.isArray(result.issues) ? result.issues : []),
    ];
    scene.review = {
      status: issues.some((i: any) => i.severity === "high")
        ? "needs-revision"
        : result.status === "reviewed"
          ? "reviewed"
          : "needs-revision",
      summary: String(result.summary ?? ""),
      issues,
    };
    log("critic", "complete", scene.review.summary);
    return {
      repairs: Array.isArray(result.repairs) ? result.repairs.slice(0, 2) : [],
      assemblyInstruction: result.assemblyInstruction,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    scene.review = {
      status: "unavailable",
      summary:
        "AI visual review was unavailable. This figure has not passed visual review.",
      issues: structuralIssues(scene),
    };
    log("critic", "warning", String(error));
    return { repairs: [] };
  }
}
async function parallelWorkers<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index]);
      }
    }),
  );
}
export async function generate(
  input: RunInput,
  run: RunRecord,
  signal: AbortSignal,
  log: Log,
) {
  if (input.config.pipeline === "visual-reconstruction" && !input.moduleId) {
    await generateVisualReconstruction(input, run, signal, log);
    return;
  }
  if (input.scene && input.moduleId) {
    const scene = structuredClone(input.scene),
      module = scene.modules.find((m) => m.id === input.moduleId);
    if (!module) throw Error("Selected module no longer exists");
    if (module.locked) throw Error("Unlock this module before regenerating it");
    const replacement = await specialize(
      {
        ...module,
        width: module.contentWidth ?? module.width,
        height: module.contentHeight ?? module.height,
      },
      input,
      scene.style,
      signal,
      log,
      input.instruction,
      module,
      (d) => {
        run.drafts ??= {};
        run.drafts[module.id] = d;
      },
    );
    scene.modules = scene.modules.map((m) =>
      m.id === module.id
        ? {
            ...replacement,
            x: module.x,
            y: module.y,
            width: module.width,
            height: module.height,
          }
        : m,
    );
    // A local request cannot move unrelated modules or rerun global generation.
    scene.review = undefined;
    scene.history = [...(scene.history ?? []), ...run.events];
    run.scene = scene;
    return;
  }
  let scene: FigureScene;
  if (input.resumeScene) {
    scene = structuredClone(input.resumeScene);
    if (
      scene.schema !== "paper-atelier/1" ||
      !scene.semanticPlan ||
      !scene.modules.length
    )
      throw Error("This draft has no resumable module contracts");
    if (
      scene.materials?.some(
        (old) =>
          !input.materials.some(
            (m) => m.name === old.name && m.content === old.content,
          ),
      )
    )
      throw Error(
        "Materials changed. Redesign the whole figure rather than resuming a stale science plan.",
      );
    validateSemantic(
      scene.semanticPlan,
      new Set(input.materials.map((m) => m.name)),
    );
    log(
      "director",
      "complete",
      "Resuming saved layout and module contracts; completed modules will not be regenerated",
    );
  } else {
    log(
      "grounder",
      "running",
      "Extract scientific components, relationships and source constraints",
    );
    if (input.resumePlanning)
      validatePlanningCheckpoint(input.resumePlanning, input);
    const semantic =
      input.resumePlanning?.semanticPlan ??
      ((await boundModel(input.config.connections?.planner, modelJson)(input.config.planner,
        groundingPrompt,
        {
          materials: input.materials,
          intent: input.intent,
          figureType: input.figureType,
        },
        [],
        signal,
        5000,
      )) as SemanticPlan);
    run.drafts ??= {};
    run.drafts.grounder = semantic;
    validateSemantic(semantic, new Set(input.materials.map((m) => m.name)));
    log(
      "grounder",
      "complete",
      `${semantic.components.length} grounded components · ${semantic.relationships.length} scientific relationships`,
    );
    const images = await referenceImages(input.references);
    log(
      "director",
      "running",
      "Design content-adaptive composition and specialist subfigure briefs",
    );
    let design: DesignPlan | undefined, lastError: unknown;
    if (input.resumePlanning?.designDraft) {
      try {
        const saved = structuredClone(input.resumePlanning.designDraft);
        validateDesign(saved, semantic);
        design = saved;
        log(
          "director",
          "complete",
          "Recovered the saved visual blueprint without another model call",
        );
      } catch (e) {
        lastError = e;
      }
    }
    for (let attempt = 0; !design && attempt < 2; attempt++) {
      const result = (await boundModel(input.config.connections?.director, modelJson)(input.config.director,
        directorPrompt + '\nGlobal constraint annotations may carry componentIds:["exact-semantic-id"] to account for scientific constraints that do not belong inside a specialist module. Do not omit these constraints or put an artificial constraint box inside the main mechanism.',
        {
          semanticPlan: semantic,
          intent: input.intent,
          materials: input.materials,
          referenceDescriptions: input.references.map((r) => ({
            name: r.name,
            description: r.description,
          })),
          previousDraft: input.resumePlanning?.designDraft,
          validationFeedback: lastError ? String(lastError) : undefined,
        },
        images,
        signal,
        8500,
      )) as DesignPlan;
      run.drafts ??= {};
      run.drafts.director = structuredClone(result);
      try {
        validateDesign(result, semantic);
        design = result;
        break;
      } catch (e) {
        lastError = e;
        log("director", "warning", String(e));
      }
    }
    if (!design) throw lastError;
    log("director", "complete", design.rationale);
    if(input.publicationWidthPt){
      const minimum=Math.ceil(design.width/input.publicationWidthPt*7.5);
      design.style.minimumFontSize=minimum;
      design.style.bodySize=Math.max(design.style.bodySize,minimum);
      design.style.titleSize=Math.max(design.style.titleSize,minimum+3);
    }
    scene = {
      schema: "paper-atelier/1",
      id: randomUUID(),
      title: design.title,
      width: design.width,
      height: design.height,
      publicationWidthPt:input.publicationWidthPt,
      style: design.style,
      regions: design.regions,
      modules: design.modules.map((m) => ({
        ...m,
        elements: [],
        method: input.config.methods[m.role],
        status: "pending",
        contentWidth: m.width,
        contentHeight: m.height,
      })),
      connectors: design.connectors,
      annotations: fitModuleText(
        design.annotations,
        design.width,
        design.height,
        design.style,
      ),
      semanticPlan: semantic,
      designRationale: design.rationale,
      materials: input.materials,
      references: input.references.map(({ dataUrl, ...r }) => r),
      agentConfig: input.config,
      intent: input.intent,
      figureType: input.figureType,
    };
  }
  if(input.publicationWidthPt)scene.publicationWidthPt=input.publicationWidthPt;
  scene.annotations = scene.annotations.length
    ? fitModuleText(
        normalizeElements(
          scene.annotations,
          {
            id: "annotations",
            width: scene.width,
            height: scene.height,
            labels: [],
          },
          false,
        ),
        scene.width,
        scene.height,
        scene.style,
      )
    : [];
  scene.history = [...(scene.history ?? []), ...run.events];
  run.scene = scene;
  const errors: string[] = [];
  await parallelWorkers(
    scene.modules.filter((m) => m.status !== "ready"),
    3,
    async (brief) => {
      try {
        if (brief.locked)
          throw Error("Unlock the unfinished module before resuming");
        const module = await specialize(
          brief,
          input,
          scene.style,
          signal,
          log,
          undefined,
          undefined,
          (d) => {
            run.drafts ??= {};
            run.drafts[brief.id] = d;
          },
          input.resumeScene?.agentConfig?.worker === input.config.worker
            ? input.resumeDrafts?.[brief.id]
            : undefined,
        );
        scene.modules = scene.modules.map((m) =>
          m.id === brief.id ? module : m,
        );
      } catch (e) {
        const message = String(e);
        errors.push(brief.id + ": " + message);
        scene.modules = scene.modules.map((m) =>
          m.id === brief.id
            ? { ...m, status: "error", generation: message }
            : m,
        );
        log("worker:" + brief.id, "error", message);
      }
      run.scene = { ...scene, modules: [...scene.modules] };
    },
  );
  if (errors.length) throw Error(errors.join("; "));
  let composed = await assemble(scene, input, signal, log);
  run.scene = composed;
  if (input.config.reviewRounds > 0) {
    for (let round = 0; round < input.config.reviewRounds; round++) {
      const report = await reviewSceneDocument(composed, input, signal, log);
      run.scene = composed;
      if (
        round >= input.config.reviewRounds - 1 ||
        (!report.repairs.length && !report.assemblyInstruction)
      )
        break;
      for (const task of report.repairs) {
        const module = composed.modules.find((m) => m.id === task.moduleId);
        if (!module || module.locked) continue;
        try {
          const revisedLabels = Array.isArray(task.revisedLabels)
            ? task.revisedLabels.filter((x: unknown) => typeof x === "string")
            : module.labels;
          const replacement = await specialize(
            {
              ...module,
              labels: revisedLabels,
              width: module.contentWidth ?? module.width,
              height: module.contentHeight ?? module.height,
            },
            input,
            composed.style,
            signal,
            log,
            String(task.instruction),
            module,
          );
          composed.modules = composed.modules.map((m) =>
            m.id === module.id
              ? {
                  ...replacement,
                  x: module.x,
                  y: module.y,
                  width: module.width,
                  height: module.height,
                }
              : m,
          );
        } catch (e) {
          if (signal.aborted) throw e;
          log(
            "critic",
            "warning",
            `Rejected failed local revision; previous module preserved: ${String(e)}`,
          );
          composed.review!.status = "needs-revision";
        }
      }
      if (report.assemblyInstruction) {
        try {
          composed = await assemble(
            composed,
            input,
            signal,
            log,
            String(report.assemblyInstruction),
          );
        } catch (e) {
          if (signal.aborted) throw e;
          log(
            "critic",
            "warning",
            `Rejected failed global revision; previous composition preserved: ${String(e)}`,
          );
          composed.review!.status = "needs-revision";
        }
      }
    }
  }
  composed.history = [...(input.resumeScene?.history ?? []), ...run.events];
  run.scene = composed;
}

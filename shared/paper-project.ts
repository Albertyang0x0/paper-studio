import type {
  Candidate,
  ModuleId,
  ModuleOutput,
  PaperMaterial,
  PaperProject,
  PaperModule,
  PaperTemplate,
} from "./paper-types";
import {
  moduleOrder,
  moduleLabels,
  moduleDependencies,
  manuscriptOrder,
} from "./paper-types";
import { defaultMethod } from "./paper-methods";

export class ProjectConflict extends Error {}
export function scientificRiskWarnings(content: string): string[] {
  return /\b(consistently improves?|universally|always improves?|essential|vital|state[- ]of[- ]the[- ]art)\b/i.test(
    content,
  )
    ? [
        "检测到绝对化结果或必要性用语。请检查负结果、反例和因果证据；这是风险提示，不是已证实的错误判定。",
      ]
    : [];
}
const now = () => new Date().toISOString();
export function createPaper(
  id: string,
  title: string,
  ideaSpark: string,
  materials: PaperMaterial[] = [],
  language: "en" | "zh" = "en",
): PaperProject {
  const createdAt = now();
  return {
    schema: "paper-workbench/1",
    id,
    title: title.trim() || "Untitled research",
    ideaSpark,
    materials,
    language,
    guidelines:
      "Anonymized ML research draft. Ground every scientific claim in the supplied materials; disclose missing evidence.",
    revision: 0,
    sourceRevision: 0,
    createdAt,
    updatedAt: createdAt,
    citations: [],
    assets: [],
    candidates: [],
    events: [],
    modules: Object.fromEntries(
      moduleOrder.map((moduleId) => [
        moduleId,
        {
          id: moduleId,
          content: "",
          revision: 0,
          methodId: defaultMethod(moduleId),
          model: "",
          locked: false,
          needsSync: [],
          assetIds: [],
          history: [
            {
              revision: 0,
              content: "",
              assetIds: [],
              methodId: "manual",
              model: "",
              reason: "项目创建",
              createdAt,
              warnings: [],
            },
          ],
        },
      ]),
    ) as unknown as Record<ModuleId, PaperModule>,
  };
}
export function touch(p: PaperProject, action: string, moduleId?: ModuleId) {
  p.revision++;
  p.updatedAt = now();
  p.events.push({
    id: crypto.randomUUID(),
    time: p.updatedAt,
    action,
    moduleId,
  });
}
function changedModule(
  p: PaperProject,
  id: ModuleId,
  content: string,
  methodId: string,
  model: string,
  reason: string,
  warnings: string[],
  assetIds: string[],
  candidateId?: string,
) {
  const m = p.modules[id];
  m.content = content;
  if (methodId !== "manual") m.methodId = methodId;
  if (model) m.model = model;
  m.assetIds = [...assetIds];
  m.revision++;
  m.needsSync = [];
  m.history.push({
    revision: m.revision,
    content,
    methodId,
    model,
    reason,
    warnings,
    assetIds: [...assetIds],
    candidateId,
    createdAt: now(),
  });
  for (const dependent of moduleOrder) {
    const other = p.modules[dependent];
    if (
      moduleDependencies[dependent].includes(id) &&
      other.content &&
      !other.needsSync.includes(id)
    )
      other.needsSync.push(id);
  }
  touch(p, reason, id);
}
export function saveModule(
  p: PaperProject,
  id: ModuleId,
  expectedRevision: number,
  content: string,
) {
  if (p.modules[id].revision !== expectedRevision)
    throw new ProjectConflict(
      "当前章节已被修改，请刷新后比较版本；未覆盖任何内容。",
    );
  if (id === "figures" && p.modules.figures.assetIds.length)
    throw Error(
      "图表概览由对象与图注生成；请逐图修改图注，或在画板中编辑对象。",
    );
  if (id === "outline") delete p.outlineData;
  changedModule(
    p,
    id,
    content,
    "manual",
    "",
    "手动编辑",
    [],
    p.modules[id].assetIds,
  );
}
export function restoreModule(
  p: PaperProject,
  id: ModuleId,
  expectedRevision: number,
  revision: number,
) {
  if (p.modules[id].revision !== expectedRevision)
    throw new ProjectConflict("当前章节版本已变化。");
  const version = p.modules[id].history.find((v) => v.revision === revision);
  if (!version) throw Error("历史版本不存在");
  // The restored human-readable outline is authoritative, not a newer cached JSON plan.
  if (id === "outline") delete p.outlineData;
  changedModule(
    p,
    id,
    version.content,
    version.methodId,
    version.model,
    `恢复版本 v${revision}`,
    version.warnings,
    version.assetIds,
  );
}
export function replaceSources(
  p: PaperProject,
  expectedRevision: number,
  data: {
    title: string;
    ideaSpark: string;
    materials: PaperMaterial[];
    language: "en" | "zh";
    guidelines: string;
    template?: PaperTemplate;
  },
) {
  if (p.revision !== expectedRevision)
    throw new ProjectConflict("项目已变化，请刷新后再更新材料。");
  // Completing the same template's dependencies is a formatting repair, not new evidence.
  // Keep chapter histories, candidate provenance, and source versions intact.
  const sameResearch = p.title === data.title && p.ideaSpark === data.ideaSpark
    && p.language === data.language && p.guidelines === data.guidelines
    && JSON.stringify(p.materials) === JSON.stringify(data.materials);
  const sameMain = p.template && data.template && p.template.entry === data.template.entry
    && p.template.files.find(f => f.name === p.template!.entry)?.content
      === data.template.files.find(f => f.name === data.template!.entry)?.content;
  if (sameResearch && sameMain) {
    p.template = data.template;
    touch(p, '更新模板依赖');
    return;
  }
  Object.assign(p, data);
  p.sourceRevision++;
  for (const m of Object.values(p.modules))
    if (m.content && !m.needsSync.includes("materials"))
      m.needsSync.push("materials");
  touch(p, "更新研究材料");
}
export function newCandidate(
  p: PaperProject,
  id: string,
  runId: string,
  moduleId: ModuleId,
  methodId: string,
  model: string,
  output: ModuleOutput,
): Candidate {
  return {
    id,
    runId,
    moduleId,
    methodId,
    model,
    baseRevision: p.modules[moduleId].revision,
    sourceRevision: p.sourceRevision,
    dependencyVersions: Object.fromEntries(
      moduleDependencies[moduleId].map((dep) => [dep, p.modules[dep].revision]),
    ),
    status: "pending",
    createdAt: now(),
    ...output,
  };
}
// A commit is not a new scientific input. Only the exact, unchanged accepted
// proposal at the expected base revision can bridge a dependency's 0 -> 1.
// Same run ID or matching prose alone is not sufficient after edits/restores.
export function isCurrentAcceptedCandidate(p: PaperProject, c: Candidate): boolean {
  const module = p.modules[c.moduleId], latest = module.history.at(-1);
  return c.status === 'accepted' && c.sourceRevision === p.sourceRevision
    && module.revision === c.baseRevision + 1 && latest?.revision === module.revision
    && latest.candidateId === c.id && latest.content === module.content
    && JSON.stringify(latest.assetIds) === JSON.stringify(module.assetIds)
    && (c.moduleId === 'figures' || c.content === module.content)
    && (c.moduleId !== 'outline' || JSON.stringify(c.outlineData) === JSON.stringify(p.outlineData));
}

function wasCandidateEdited(p: PaperProject, c: Candidate): boolean {
  // The second clause also protects existing projects created before edit
  // provenance was explicit: candidate editing retained a rejected predecessor.
  return !!c.editedFromCandidateId || p.candidates.some(previous => previous.id !== c.id
    && previous.status === 'rejected' && previous.runId === c.runId
    && previous.moduleId === c.moduleId && previous.baseRevision === c.baseRevision);
}

function dependencyMatches(p: PaperProject, c: Candidate, dep: ModuleId, revision: number): boolean {
  if (p.modules[dep].revision === revision) return true;
  return p.candidates.some(accepted => accepted.moduleId === dep && accepted.runId === c.runId
    && accepted.baseRevision === revision && isCurrentAcceptedCandidate(p, accepted)
    && !wasCandidateEdited(p, accepted));
}

export function validateCandidate(p: PaperProject, c: Candidate) {
  if (c.status !== "pending") throw new ProjectConflict("候选已处理。");
  if (p.modules[c.moduleId].locked)
    throw new ProjectConflict("当前模块已锁定，请先解锁再接受 AI 候选。");
  if (c.baseRevision !== p.modules[c.moduleId].revision)
    throw new ProjectConflict(
      "生成后当前章节已被编辑；候选已保留，未覆盖手动修改。",
    );
  if (c.sourceRevision !== p.sourceRevision)
    throw new ProjectConflict("生成后研究材料已变化，需要重新生成候选。");
  for (const [dep, revision] of Object.entries(c.dependencyVersions)) {
    if (!dependencyMatches(p, c, dep as ModuleId, revision!))
      throw new ProjectConflict(
        `候选依赖的 ${moduleLabels[dep as ModuleId]} 已变化，请重新生成。`,
      );
  }
}
function applyCandidate(p: PaperProject, c: Candidate) {
  for (const citation of c.citations ?? [])
    if (!p.citations.some((v) => v.id === citation.id))
      p.citations.push(citation);
  for (const asset of c.assets ?? [])
    if (!p.assets.some((a) => a.id === asset.id)) p.assets.push(asset);
  if (c.outlineData) p.outlineData = c.outlineData;
  const assetIds = c.assets
    ? [
        ...p.modules[c.moduleId].assetIds.filter(
          (id) =>
            !c.assets!.some(
              (updated) =>
                updated.figureId ===
                p.assets.find((old) => old.id === id)?.figureId,
            ),
        ),
        ...c.assets.map((a) => a.id),
      ]
    : p.modules[c.moduleId].assetIds;
  const content =
    c.moduleId === "figures" && c.assets
      ? assetIds
          .map((id, index) => {
            const a = p.assets.find((asset) => asset.id === id)!;
            return `**Figure ${index + 1}: ${a.title}**\n\n${a.caption}`;
          })
          .join("\n\n")
      : c.content;
  changedModule(
    p,
    c.moduleId,
    content,
    c.methodId,
    c.model,
    "接受候选版本",
    c.warnings,
    assetIds,
    c.id,
  );
  c.status = "accepted";
}
export function acceptCandidates(
  p: PaperProject,
  ids: string[],
  batch = false,
) {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw Error("需要不重复的候选 ID");
  const candidates = ids.map((id) => {
    const c = p.candidates.find((v) => v.id === id);
    if (!c) throw Error("候选不存在");
    return c;
  });
  if (new Set(candidates.map((c) => c.moduleId)).size !== candidates.length)
    throw Error("同一模块不能同时接受多个候选");
  if (batch && new Set(candidates.map((c) => c.runId)).size !== 1)
    throw Error("批次候选必须来自同一次生成");
  // Validate the entire transaction before applying anything. A batch sees one common base.
  for (const c of candidates) validateCandidate(p, c);
  for (const c of candidates) {
    for (const dep of Object.keys(c.dependencyVersions) as ModuleId[]) {
      const proposed = candidates.find(other => other.moduleId === dep && other.runId === c.runId);
      if (proposed && wasCandidateEdited(p, proposed))
        throw new ProjectConflict(`候选依赖的 ${moduleLabels[dep]} 已被编辑；请先接受修改后的章节，再更新依赖它的候选。`);
    }
  }
  const library = new Set(
    [...p.citations, ...candidates.flatMap((c) => c.citations ?? [])].map(
      (c) => c.key,
    ),
  );
  for (const c of candidates)
    for (const key of citationKeys(c.content))
      if (!library.has(key))
        throw Error(`缺少引用 ${key}，请先接受对应的引用库候选。`);
  for (const c of candidates.sort(
    (a, b) => moduleOrder.indexOf(a.moduleId) - moduleOrder.indexOf(b.moduleId),
  ))
    applyCandidate(p, c);
  // Reconcile the whole accepted family, including chapters committed by an
  // earlier click. Genuine manual/source changes keep their synchronization flag.
  const runs = new Set(candidates.map(c => c.runId));
  for (const c of p.candidates.filter(c => runs.has(c.runId) && isCurrentAcceptedCandidate(p, c)))
    p.modules[c.moduleId].needsSync = p.modules[c.moduleId].needsSync.filter(dep => {
      const expected = c.dependencyVersions[dep as ModuleId];
      return expected === undefined || !dependencyMatches(p, c, dep as ModuleId, expected);
    });
}
export function citationKeys(content: string): string[] {
  return [
    ...new Set(
      [...content.matchAll(/\[@([^\]]+)\]/g)].flatMap((match) =>
        match[1]
          .split(/\s*;\s*/)
          .map((k) => k.replace(/^@/, "").trim())
          .filter(Boolean),
      ),
    ),
  ];
}
export function bibliographyMarkdown(
  p: Pick<PaperProject, "citations">,
): string {
  return p.citations
    .map(
      (c) =>
        `- **${c.key}** — ${c.authors.join(", ")} (${c.year ?? "n.d."}). ${c.title}. ${c.venue || ""} ${c.url ? `[Source](${c.url})` : ""}`,
    )
    .join("\n");
}
export function manuscriptMarkdown(p: PaperProject): string {
  return (
    `# ${p.title}\n\n> Research draft · Missing evidence must be supplied before submission.\n\n` +
    manuscriptOrder
      .map(
        (id) =>
          `## ${moduleLabels[id]}\n\n${p.modules[id].content || "[TODO: This module has not been written.]"}`,
      )
      .join("\n\n")
  );
}
export function lineDiff(
  before: string,
  after: string,
): { kind: "same" | "add" | "remove"; text: string }[] {
  const a = before.split("\n"),
    b = after.split("\n");
  // Bound memory for unusually long imported sections.
  if (a.length * b.length > 250000)
    return [
      ...a.map((text) => ({ kind: "remove" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  const dp = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const result: ReturnType<typeof lineDiff> = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({ kind: "same", text: a[i++] });
      j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j]))
      result.push({ kind: "add", text: b[j++] });
    else result.push({ kind: "remove", text: a[i++] });
  }
  return result;
}

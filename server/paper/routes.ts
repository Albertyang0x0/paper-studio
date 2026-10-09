import { Router, type Request, type Response } from "express";
import { apiSettings } from '../api-settings';
import { defaultTextModel, withApiConnections } from '../provider-runtime';
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type {
  Candidate,
  Citation,
  FigureAsset,
  ModuleId,
  PaperMaterial,
  PaperProject,
  PaperRun,
} from "../../shared/paper-types";
import { moduleOrder, moduleLabels } from "../../shared/paper-types";
import {
  acceptCandidates,
  bibliographyMarkdown,
  createPaper,
  manuscriptMarkdown,
  newCandidate,
  ProjectConflict,
  replaceSources,
  restoreModule,
  saveModule,
  touch,
  validateCandidate,
} from "../../shared/paper-project";
import { sceneSvg } from "../../shared/svg";
import { structuralIssues } from "../validation";
import { PaperStore, assertId } from "./store";
import { adapterDefinitions } from "./adapters";
import { validateResumeCandidate } from '../../shared/paper-run';
import { bibliographyBib, paperTex, paperSourceBundle } from "./export";
import { buildPreview } from './preview';
import { validateTemplate } from "../../shared/paper-template";
import { reviewManuscript } from './research';
import { generatePaperRun } from './generation';
import { assertProjectScope, storageConfig, outputPath } from '../storage';

export const paperStore = new PaperStore();
const running = new Map<
  string,
  { run: PaperRun; controller: AbortController }
>();
const projectRuns = new Map<string, string>();
function moduleId(id: string): ModuleId {
  if (!(moduleOrder as readonly string[]).includes(id))
    throw Error("Invalid module");
  return id as ModuleId;
}
function materials(value: unknown): PaperMaterial[] {
  if (!Array.isArray(value) || value.length > 60)
    throw Error("材料列表格式无效或过多");
  return value.map((v) => {
    if (
      typeof v?.name !== "string" ||
      typeof v?.content !== "string" ||
      v.content.length > 1000000 ||
      !["idea", "experiment", "context"].includes(v.role)
    )
      throw Error("研究材料格式无效");
    return {
      id: typeof v.id === "string" ? v.id : randomUUID(),
      name: v.name.slice(0, 160),
      role: v.role,
      content: v.content,
    };
  });
}
function sceneAsset(body: any, p: PaperProject): FigureAsset {
  const scene = body.scene;
  if (
    scene?.schema !== "paper-atelier/1" ||
    !Array.isArray(scene.modules) ||
    !Array.isArray(scene.annotations) ||
    !Array.isArray(scene.connectors) ||
    !Array.isArray(scene.regions) ||
    !Number.isFinite(scene.width) ||
    !Number.isFinite(scene.height)
  )
    throw Error("不是有效的矢量对象项目");
  const previous = [
    ...p.assets,
    ...p.candidates.flatMap((c) => c.assets ?? []),
  ].find((a) => a.id === body.previousAssetId);
  return {
    id: randomUUID(),
    figureId: previous?.figureId ?? randomUUID(),
    version: (previous?.version ?? 0) + 1,
    title: String(body.title ?? scene.title).slice(0, 300),
    caption: String(body.caption ?? "").slice(0, 10000),
    scene,
    createdAt: new Date().toISOString(),
    key: previous?.key,
    placement: previous?.placement,
    provenance: previous?.provenance,
  };
}
function validateImport(p: any): asserts p is PaperProject {
  if (
    p?.schema !== "paper-workbench/1" ||
    typeof p.title !== "string" ||
    typeof p.ideaSpark !== "string" ||
    !p.modules ||
    !Array.isArray(p.candidates) ||
    !Array.isArray(p.citations) ||
    !Array.isArray(p.assets) ||
    !Array.isArray(p.events) ||
    !Number.isInteger(p.revision) ||
    !Number.isInteger(p.sourceRevision)
  )
    throw Error("不是有效的论文项目");
  materials(p.materials);
  p.template = validateTemplate(p.template);
  for (const id of moduleOrder) {
    const m = p.modules[id];
    if (
      m?.id !== id ||
      typeof m.content !== "string" ||
      !Number.isInteger(m.revision) ||
      !Array.isArray(m.history) ||
      !Array.isArray(m.assetIds) ||
      !Array.isArray(m.needsSync)
    )
      throw Error(`模块 ${id} 格式无效`);
  }
  for (const a of p.assets) {
    assertId(a.id);
    if (a.scene?.schema !== "paper-atelier/1") throw Error("图表对象模型无效");
  }
  for (const c of p.candidates) {
    assertId(c.id);
    moduleId(c.moduleId);
    if (typeof c.content !== "string" || !c.dependencyVersions)
      throw Error("候选格式无效");
  }
}
const safeError = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /sk-or-v1-[a-z0-9]+/gi,
    "[redacted]",
  );
function handler(
  fn: (req: Request, res: Response) => unknown | Promise<unknown>,
) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      res
        .status(
          e instanceof ProjectConflict ? 409 : e.code === "ENOENT" ? 404 : 400,
        )
        .json({ error: safeError(e) });
    }
  };
}
export const paperRouter = Router();
paperRouter.use((req, res, next) => {
  if (req.method !== "GET" && !req.is("application/json"))
    return res.status(415).json({ error: "JSON requests only" });
  next();
});
paperRouter.get(
  "/workbench/status",
  handler(async (_req, res) => {
    const pdfAvailable = await new Promise<boolean>((done) =>
      execFile(
        process.env.PAPER_PDFLATEX ?? "pdflatex",
        ["--version"],
        { timeout: 5000, windowsHide: true },
        (error) => done(!error),
      ),
    );
    res.json({
      configured: apiSettings.status().configured,
      model: defaultTextModel(),
      pdfAvailable,
      version: "0.1.0",
      contract: "paper-module/1",
      dataScope: storageConfig().scope,
      connectivity: await readFile(outputPath('qa', 'gemini-connectivity.json'), "utf8")
        .then(raw => JSON.parse(raw)).catch(() => undefined),
    });
  }),
);
paperRouter.get("/paper-methods", (_req, res) =>
  res.json({ methods: adapterDefinitions() }),
);
paperRouter.get('/papers/:id/runs',handler(async(req,res)=>{
  const id=String(req.params.id);await paperStore.load(id);
  res.json({runs:await paperStore.listRuns(id)});
}));
paperRouter.get('/paper-template/example', handler(async (_req, res) => {
  const base = join(process.cwd(), 'examples', 'demo', 'template');
  const files = await Promise.all(['template.tex', 'paperstudio_demo.sty'].map(async name => ({ name, content: await readFile(join(base, name), 'utf8') })));
  res.json(validateTemplate({ name: 'Synthetic demo · article', entry: 'template.tex', files }));
}));
paperRouter.get(
  "/papers",
  handler(async (_req, res) => res.json({ projects: await paperStore.list() })),
);
paperRouter.post(
  "/papers",
  handler(async (req, res) => {
    const idea =
      typeof req.body.ideaSpark === "string" ? req.body.ideaSpark.trim() : "";
    if (!idea && !req.body.materials?.length)
      throw Error("请输入 idea spark 或导入研究材料");
    assertProjectScope(String(req.body.title ?? ''));
    const p = createPaper(
      randomUUID(),
      String(req.body.title ?? ""),
      idea,
      materials(req.body.materials ?? []),
      req.body.language === "zh" ? "zh" : "en",
    );
    if (typeof req.body.guidelines === "string")
      p.guidelines = req.body.guidelines.slice(0, 20000);
    p.template = validateTemplate(req.body.template);
    await paperStore.save(p);
    res.status(201).json(p);
  }),
);
paperRouter.post(
  "/papers/import",
  handler(async (req, res) => {
    const p = req.body.project;
    validateImport(p);
    assertProjectScope(p.title);
    p.id = randomUUID();
    p.createdAt = new Date().toISOString();
    touch(p, "从可移植项目导入");
    await paperStore.save(p);
    res.status(201).json(p);
  }),
);
paperRouter.get(
  "/papers/:id",
  handler(async (req, res) =>
    res.json(await paperStore.load(String(req.params.id))),
  ),
);
paperRouter.post(
  "/papers/:id/materials",
  handler(async (req, res) => {
    const p = await paperStore.mutate(String(req.params.id), (p) => {
      if (
        req.body.expectedSourceRevision !== undefined &&
        req.body.expectedSourceRevision !== p.sourceRevision
      )
        throw new ProjectConflict(
          "材料编辑期间来源已被更新；未覆盖新材料，请刷新后比较。",
        );
      replaceSources(p, Number(req.body.expectedRevision), {
        title: String(req.body.title).slice(0, 300),
        ideaSpark: String(req.body.ideaSpark),
        materials: materials(req.body.materials),
        language: req.body.language === "zh" ? "zh" : "en",
        guidelines: String(req.body.guidelines ?? ""),
        template: validateTemplate(req.body.template),
      });
    });
    res.json(p);
  }),
);
paperRouter.post(
  "/papers/:id/modules/:moduleId",
  handler(async (req, res) => {
    const id = moduleId(String(req.params.moduleId));
    if (
      typeof req.body.content !== "string" ||
      req.body.content.length > 150000
    )
      throw Error("章节内容无效或过长");
    res.json(
      await paperStore.mutate(String(req.params.id), (p) =>
        saveModule(p, id, Number(req.body.expectedRevision), req.body.content),
      ),
    );
  }),
);
paperRouter.post(
  "/papers/:id/modules/:moduleId/lock",
  handler(async (req, res) => {
    const id = moduleId(String(req.params.moduleId));
    res.json(
      await paperStore.mutate(String(req.params.id), (p) => {
        p.modules[id].locked = Boolean(req.body.locked);
        touch(p, p.modules[id].locked ? "锁定模块" : "解锁模块", id);
      }),
    );
  }),
);
paperRouter.post(
  "/papers/:id/modules/:moduleId/method",
  handler(async (req, res) => {
    const id = moduleId(String(req.params.moduleId));
    const definition = adapterDefinitions().find(
      (m) => m.id === req.body.methodId && m.modules.includes(id),
    );
    if (!definition) throw Error("该方法未注册或不支持当前模块");
    for(const [key,kind] of [['connectionId','text'],['imageConnectionId','image']] as const)
      if(req.body[key]) apiSettings.resolve(String(req.body[key]),kind,false);
    res.json(
      await paperStore.mutate(String(req.params.id), (p) => {
        p.modules[id].methodId = definition.id;
        p.modules[id].model = String(req.body.model ?? "").slice(0, 150);
        if(req.body.connectionId!==undefined)p.modules[id].connectionId=String(req.body.connectionId)||undefined;
        if(req.body.imageConnectionId!==undefined)p.modules[id].imageConnectionId=String(req.body.imageConnectionId)||undefined;
        if(req.body.imageModel!==undefined)p.modules[id].imageModel=String(req.body.imageModel).slice(0,150)||undefined;
        touch(p, "保存模块方法配置", id);
      }),
    );
  }),
);
paperRouter.post(
  "/papers/:id/modules/:moduleId/restore",
  handler(async (req, res) => {
    const id = moduleId(String(req.params.moduleId));
    res.json(
      await paperStore.mutate(String(req.params.id), (p) =>
        restoreModule(
          p,
          id,
          Number(req.body.expectedRevision),
          Number(req.body.revision),
        ),
      ),
    );
  }),
);
paperRouter.post(
  "/papers/:id/candidates/accept",
  handler(async (req, res) => {
    if (!Array.isArray(req.body.ids)) throw Error("候选 ID 格式无效");
    res.json(
      await paperStore.mutate(String(req.params.id), (p) =>
        acceptCandidates(p, req.body.ids, Boolean(req.body.batch)),
      ),
    );
  }),
);
paperRouter.post(
  "/papers/:id/candidates/:candidateId/reject",
  handler(async (req, res) => {
    res.json(
      await paperStore.mutate(String(req.params.id), (p) => {
        const c = p.candidates.find((v) => v.id === req.params.candidateId);
        if (!c || c.status !== "pending") throw Error("没有待处理的候选");
        c.status = "rejected";
        touch(p, "拒绝候选版本", c.moduleId);
      }),
    );
  }),
);
paperRouter.post(
  "/papers/:id/citations",
  handler(async (req, res) => {
    const b = req.body;
    if (
      !b.title?.trim() ||
      !Array.isArray(b.authors) ||
      b.authors.some((a: unknown) => typeof a !== "string")
    )
      throw Error("请输入真实文献标题与作者列表");
    const citation: Citation = {
      id: "user:" + randomUUID(),
      key: "User_" + randomUUID().slice(0, 8),
      title: String(b.title).slice(0, 500),
      authors: b.authors.slice(0, 50),
      year: Number(b.year) || null,
      venue: String(b.venue ?? ""),
      abstract: String(b.abstract ?? "").slice(0, 20000),
      url: /^https?:\/\//.test(b.url ?? "") ? b.url : "",
      verification: "user-provided",
      provider: "Manual",
    };
    res.json(
      await paperStore.mutate(String(req.params.id), (p) => {
        if (b.id) {
          const previous = p.citations.find((c) => c.id === b.id);
          if (!previous) throw Error("文献不存在");
          Object.assign(previous, citation, {
            id: previous.id,
            key: previous.key,
            venue: b.venue === undefined ? previous.venue : citation.venue,
          });
          delete previous.verifiedAt;
        } else p.citations.push(citation);
        saveModule(
          p,
          "references",
          p.modules.references.revision,
          bibliographyMarkdown(p),
        );
      }),
    );
  }),
);
paperRouter.post(
  "/papers/:id/figure-candidates",
  handler(async (req, res) => {
    res.json(
      await paperStore.mutate(String(req.params.id), async (p) => {
        if (p.modules.figures.locked) throw Error("图表模块已锁定");
        if (p.modules.figures.revision !== Number(req.body.expectedRevision))
          throw new ProjectConflict("图表主稿版本已变化，请重新打开画板");
        if (p.sourceRevision !== Number(req.body.expectedSourceRevision))
          throw new ProjectConflict(
            "编辑期间研究材料已变化，图表候选未写入。请重新载入最新材料。",
          );
        for (const id of ["method", "experiments"] as const)
          if (
            req.body.expectedDependencyVersions?.[id] !== p.modules[id].revision
          )
            throw new ProjectConflict(
              `编辑期间 ${moduleLabels[id]} 已变化，需核对图表后重新载入。`,
            );
        const asset = sceneAsset(req.body, p),
          warnings = structuralIssues(asset.scene).map((v) => v.message);
        const parent=p.candidates.find(c=>c.status==='pending' && c.moduleId==='figures'
          && c.assets?.some(a=>a.id===req.body.previousAssetId));
        if(parent)validateCandidate(p,parent);
        if(parent&&running.has(parent.runId))throw Error('生成中不能提交图表候选修改，请等待任务完成');
        const assets=parent?.assets?.map(a=>a.figureId===asset.figureId ? asset : a) ?? [asset];
        const candidate = newCandidate(
          p,
          randomUUID(),
          parent?.runId ?? randomUUID(),
          "figures",
          "vector-atelier",
          asset.scene.agentConfig?.worker ?? "",
          {
            content:
              asset.caption || `[TODO: Add a caption for ${asset.title}]`,
            assets,
            warnings: [
              ...warnings,
              "可编辑对象已保留。视觉质量、内容忠实度和图注仍需人工确认。",
            ],
          },
        );
        if(parent){
          candidate.editedFromCandidateId=parent.id;
          parent.status='rejected';
          // Keep the completed run's candidate identity in sync with an edited batch.
          // The stored historical candidate remains available as a rejected version.
          const record=await paperStore.loadRun(parent.runId).catch(()=>undefined);
          if(record){record.candidateIds=record.candidateIds.map(id=>id===parent.id?candidate.id:id);await paperStore.saveRun(record);}
        }
        p.candidates.push(candidate);
        touch(p, "画板提交候选", "figures");
      }),
    );
  }),
);
paperRouter.post('/papers/:id/candidates/:candidateId/edit',handler(async(req,res)=>{
  const id=String(req.params.id);let previousRunId='',oldId='',newId='';
  const result=await paperStore.mutate(id,p=>{
    const previous=p.candidates.find(c=>c.id===req.params.candidateId);
    if(!previous)throw Error('候选不存在');validateCandidate(p,previous);
    if(running.has(previous.runId))throw Error('生成中不能修改章节候选，请等待任务完成');
    if(['figures','references'].includes(previous.moduleId))throw Error('请通过画板或引用编辑器修改结构化候选');
    if(typeof req.body.content!=='string'||!req.body.content.trim()||req.body.content.length>150000)throw Error('候选内容为空或过长');
    const candidate={...structuredClone(previous),id:randomUUID(),content:req.body.content,
      editedFromCandidateId:previous.id,createdAt:new Date().toISOString(),status:'pending' as const};
    if(candidate.moduleId==='outline')delete candidate.outlineData;
    previous.status='rejected';p.candidates.push(candidate);touch(p,'编辑章节候选',candidate.moduleId);
    previousRunId=previous.runId;oldId=previous.id;newId=candidate.id;
  });
  const record=await paperStore.loadRun(previousRunId).catch(()=>undefined);
  if(record){record.candidateIds=record.candidateIds.map(cid=>cid===oldId?newId:cid);await paperStore.saveRun(record);}
  res.json(result);
}));
paperRouter.get(
  "/papers/:id/assets/:assetId.svg",
  handler(async (req, res) => {
    const p = await paperStore.load(String(req.params.id)),
      a = [...p.assets,...p.candidates.filter(c=>c.status==='pending').flatMap(c=>c.assets??[])].find((v) => v.id === req.params.assetId);
    if (!a) return res.status(404).json({ error: "Figure not found" });
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    res.type("image/svg+xml").send(sceneSvg(a.scene));
  }),
);
paperRouter.get(
  "/papers/:id/export/:format",
  handler(async (req, res) => {
    const p = await paperStore.load(String(req.params.id)),
      format = String(req.params.format);
    if (format === 'zip') {
      res.setHeader('Content-Disposition', `attachment; filename="paper-${p.id}.zip"`);
      res.type('application/zip').send(await paperSourceBundle(p));
      return;
    }
    const content =
      format === "md"
        ? manuscriptMarkdown(p)
        : format === "tex"
          ? paperTex(p)
          : format === "bib"
            ? bibliographyBib(p)
            : format === "json"
              ? JSON.stringify(p, null, 2)
              : undefined;
    if (content === undefined) throw Error("不支持的导出格式");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="paper-${p.id}.${format}"`,
    );
    res
      .type(format === "json" ? "application/json" : "text/plain")
      .send(content);
  }),
);
paperRouter.post(
  "/papers/:id/build",
  handler(async (req, res) => {
    const p = await paperStore.load(String(req.params.id));
    if (req.body.expectedRevision !== undefined && req.body.expectedRevision !== p.revision)
      throw new ProjectConflict('项目已更新，请刷新后预览最新主稿。');
    const build = await buildPreview(p, paperStore.root);
    res.json({ ...build, url: `/api/papers/${p.id}/builds/${build.id}/pdf` });
  }),
);
paperRouter.get(
  "/papers/:id/builds/:buildId/pdf",
  handler(async (req, res) => {
    const id = String(req.params.id),
      buildId = String(req.params.buildId);
    assertId(id);
    assertId(buildId);
    const path = join(paperStore.root, id, "builds", buildId, "main.pdf");
    await access(path);
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="paper-${id}.pdf"`);
    res.type("application/pdf").sendFile(path);
  }),
);

paperRouter.post(
  "/paper-runs",
  handler(async (req, res) => {
    const p = await paperStore.load(String(req.body.projectId));
    if (projectRuns.has(p.id))
      throw new ProjectConflict("该项目已有生成任务，请先完成或取消。");
    if (!apiSettings.status().configured && !req.body.connectionId && !p.modules[moduleId(String(req.body.moduleId??'outline'))].connectionId)
      throw Error(
        "请在工作台“API 设置”中配置可用连接。",
      );
    if (p.revision !== req.body.expectedRevision)
      throw new ProjectConflict("项目状态已变化，请刷新后开始生成。");
    const mode = req.body.mode === "draft" ? "draft" : "module",
      target = moduleId(String(req.body.moduleId ?? "outline"));
    if (mode === "module" && p.modules[target].locked)
      throw Error("当前模块已锁定");
    const executionOrder: ModuleId[] = [
      "outline",
      "references",
      "method",
      "experiments",
      "figures",
      "related_work",
      "introduction",
      "abstract",
      "conclusion",
    ];
    const selected =
      mode === "draft"
        ? executionOrder.filter((id) => !p.modules[id].locked)
        : [target];
    const model = String(
      req.body.model ??
        defaultTextModel(req.body.connectionId||p.modules[target].connectionId),
    );
    if (!model.trim() || model.length > 150) throw Error("模型 ID 无效");
    const configuration: NonNullable<PaperRun["configuration"]> = {
      modules: selected,
      methods: Object.fromEntries(
        selected.map((id) => [
          id,
          mode === "module"
            ? String(req.body.methodId)
            : String(req.body.methods?.[id] ?? p.modules[id].methodId),
        ]),
      ),
      models: Object.fromEntries(
        selected.map((id) => [
          id,
          mode === "module"
            ? model
            : String(req.body.models?.[id] || p.modules[id].model || defaultTextModel(req.body.connections?.[id]||p.modules[id].connectionId)),
        ]),
      ),
      instruction: String(req.body.instruction ?? ""),
      skipReferenceSearch: !!req.body.skipReferenceSearch,
      reviewRounds: mode === 'draft' ? Math.max(0, Math.min(3, Number(req.body.reviewRounds ?? 3))) : 0,
    };
    const connections=Object.fromEntries(selected.map(id=>[id,mode==='module' ? req.body.connectionId||p.modules[id].connectionId : req.body.connections?.[id]||p.modules[id].connectionId]));
    const imageConnections=Object.fromEntries(selected.map(id=>[id,req.body.imageConnections?.[id]||p.modules[id].imageConnectionId]));
    const imageModels=Object.fromEntries(selected.map(id=>[id,req.body.imageModels?.[id]||p.modules[id].imageModel]));
    if(Object.values(connections).some(Boolean))configuration.connections=connections;
    if(Object.values(imageConnections).some(Boolean))configuration.imageConnections=imageConnections;
    if(Object.values(imageModels).some(Boolean))configuration.imageModels=imageModels;
    for(const [kind,links] of [['text',connections],['image',imageConnections]] as const)for(const id of Object.values(links))
      if(id)apiSettings.resolve(String(id),kind,false);
    const prior = req.body.resumeRunId
      ? await paperStore.loadRun(String(req.body.resumeRunId))
      : undefined;
    if (
      prior &&
      (prior.projectId !== p.id ||
        prior.mode !== mode ||
        prior.status === "complete" ||
        prior.status === "running")
    )
      throw Error("该任务不能恢复");
    if (
      prior?.configuration &&
      JSON.stringify(prior.configuration) !== JSON.stringify(configuration)
    )
      throw new ProjectConflict(
        "恢复时方法、模型、模块锁定和生成要求必须与原任务一致；改变这些配置请开始新任务。",
      );
    const completed = prior
      ? prior.candidateIds.map((id) => {
          const c = p.candidates.find((v) => v.id === id);
          if (!c) throw Error("恢复候选不存在");
          validateResumeCandidate(p, c);
          return c;
        })
      : [];
    const run: PaperRun = prior
        ? { ...prior, configuration, status: "running", error: undefined }
        : {
            id: randomUUID(),
            projectId: p.id,
            baseProjectRevision: p.revision,
            mode,
            status: "running",
            createdAt: new Date().toISOString(),
            events: [],
            candidateIds: [],
            configuration,
          },
      controller = new AbortController();
    running.set(run.id, { run, controller });
    projectRuns.set(p.id, run.id);
    await paperStore.saveRun(run);
    res.status(202).json(run);
    const log = (stage: string, message: string) =>
      run.events.push({ stage, message, time: new Date().toISOString() });
    void withApiConnections({},()=>generatePaperRun({ baseline: structuredClone(p), run, completed,
      store: paperStore, signal: controller.signal, model, log }))
      .catch(async (e) => {
        run.status = controller.signal.aborted ? "cancelled" : "error";
        controller.abort();
        run.error = safeError(e);
        log("error", run.error);
        await paperStore.saveRun(run);
      })
      .finally(() => {
        running.delete(run.id);
        projectRuns.delete(p.id);
      });
  }),
);
paperRouter.get(
  "/paper-runs/:id",
  handler(async (req, res) => {
    const id = String(req.params.id),
      active = running.get(id);
    const run = active?.run ?? (await paperStore.loadRun(id));
    if (!active && run.status === "running") {
      run.status = "interrupted";
      run.error =
        "服务重启中断了任务。已保存的候选仍可查看，重新生成不会自动覆盖主稿。";
      await paperStore.saveRun(run);
    }
    res.json(run);
  }),
);
paperRouter.post(
  "/paper-runs/:id/cancel",
  handler(async (req, res) => {
    const active = running.get(String(req.params.id));
    if (!active) throw Error("任务不在运行");
    active.controller.abort();
    res.json({ ok: true });
  }),
);

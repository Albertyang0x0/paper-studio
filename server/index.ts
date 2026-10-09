import { config } from "dotenv";
import express from "express";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  FigureScene,
  Reference,
  RunInput,
  RunRecord,
} from "../shared/types";
import { sceneSvg } from "../shared/svg";
import { generate, pngForScene } from "./pipeline";
import { paperRouter } from "./paper/routes";
import { configureNetwork } from './network.mjs';
import { outputPath, storageConfig } from './storage';
import { apiSettings, apiSettingsRouter } from './api-settings';
import { providerModels } from './provider-transport';
import { withApiConnections, defaultTextModel } from './provider-runtime';
config({ path: ".env.local", quiet: true });
config({ quiet: true });
const network = await configureNetwork();
const storage = storageConfig();
await apiSettings.init();
console.log(`Network: ${network.mode}${network.proxyHost ? ` (${network.proxyHost})` : ''}`);
const app = express(),
  port = Number(process.env.PORT ?? 8787),
  runs = new Map<string, RunRecord>(),
  controllers = new Map<string, AbortController>();
app.use(express.json({ limit: "32mb" }));
app.use("/api", (req, res, next) => {
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    return res.status(403).json({ error: "Cross-origin local API requests are not allowed" });
  next();
});
app.use("/api/settings", apiSettingsRouter(apiSettings));
app.use("/api", paperRouter);
const referenceCandidates: Reference[] = [
  {
    id: "multi-panel",
    name: "多面板 · 数据与优化",
    url: "/references/multi-panel.png",
    description:
      "Dense scientific multipanel composition with dataset illustrations, actual notation, nested explanatory mechanisms. Style only; do not copy its training method or numerical annotations.",
  },
  {
    id: "nested-memory",
    name: "嵌套结构 · 检索与记忆",
    url: "/references/nested-memory.png",
    description:
      "Asymmetric nested architecture with dialogue/document examples, internal units and clearly owned cross-panel connections. Style only; do not copy its memory method.",
  },
  {
    id: "trajectory",
    name: "轨迹叙事 · 诊断与分支",
    url: "/references/trajectory.png",
    description:
      "Trajectory as global narrative; lower mechanism panels and branched outcomes. Style only; plotted curves and improvement claims are not source evidence.",
  },
];
const references = (await Promise.all(referenceCandidates.map(async reference =>
  await stat(join(process.cwd(), 'public', reference.url)).then(info=>info.isFile()?reference:undefined).catch(()=>undefined)
))).filter((reference): reference is Reference=>Boolean(reference));
app.get("/api/status", (_req, res) =>
  res.json({
    ok: true,
    configured: apiSettings.status().configured,
    model: defaultTextModel(),
    references,
    version: "1.0.0",
    dataScope: storage.scope,
  }),
);
app.get("/api/projects", async (_req, res) => {
  try {
    const root = outputPath('runs'),
      entries = await readdir(root);
    const projects = await Promise.all(
      entries
        .filter((id) => /^[a-f0-9-]{36}$/.test(id))
        .map(async (id) => {
          try {
            const path = join(root, id, "project.json"),
              [raw, info] = await Promise.all([
                readFile(path, "utf8"),
                stat(path),
              ]),
              scene = JSON.parse(raw) as FigureScene;
            return { id, title: scene.title, date: info.mtime.toISOString() };
          } catch {
            return null;
          }
        }),
    );
    res.json({
      projects: projects
        .filter((p) => p !== null)
        .sort((a, b) => b.date.localeCompare(a.date)),
    });
  } catch {
    res.json({ projects: [] });
  }
});
app.get("/api/projects/:id", async (req, res) => {
  if (!/^[a-f0-9-]{36}$/.test(String(req.params.id)))
    return res.status(400).json({ error: "Invalid project id" });
  try {
    res.json(
      JSON.parse(
        await readFile(
          outputPath('runs', String(req.params.id), 'project.json'),
          "utf8",
        ),
      ),
    );
  } catch {
    res.status(404).json({ error: "Project not found" });
  }
});
app.get("/api/materials/example", async (_req, res) => {
  try {
    const base = resolve('examples', 'demo', 'inputs');
    const names = ["idea.md", "experimental_log.md"];
    res.json({
      materials: await Promise.all(
        names.map(async (name) => ({
          id: randomUUID(),
          name,
          content: await readFile(join(base, name), "utf8"),
        })),
      ),
    });
  } catch (e) {
    res.status(404).json({ error: String(e) });
  }
});
app.get("/api/models", async (req, res) => {
  try {
    res.json({models:await providerModels(apiSettings.resolve(typeof req.query.connection === 'string' ? req.query.connection : undefined))});
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});
app.post("/api/runs", async (req, res) => {
  const input = req.body as RunInput;
  if (!input?.materials?.length || !input.intent?.trim() || !input.config)
    return res.status(400).json({
      error:
        "Research materials, figure intent and agent settings are required",
    });
  if (!apiSettings.status().configured && !input.config?.connections?.planner)
    return res
      .status(503)
      .json({ error: "请在工作台“API 设置”中配置可用连接。" });
  const cfg = input.config as AgentConfig;
  if (
    [cfg.planner, cfg.director, cfg.worker, cfg.assembler, cfg.critic].some(
      (v) => typeof v !== "string" || !v,
    )
  )
    return res.status(400).json({ error: "Every agent role needs a model" });
  cfg.reviewRounds = Math.max(0, Math.min(3, Number(cfg.reviewRounds) || 0));
  input.references ??= [];
  const id = randomUUID(),
    run: RunRecord = {
      id,
      status: "running",
      events: [],
      planningContext: {
        materials: input.materials,
        intent: input.intent,
        figureType: input.figureType,
      },
    },
    controller = new AbortController();
  runs.set(id, run);
  controllers.set(id, controller);
  const log = (
    stage: string,
    status: "running" | "complete" | "error" | "warning",
    message: string,
  ) =>
    run.events.push({
      id: randomUUID(),
      stage,
      status,
      message,
      time: new Date().toISOString(),
    });
  res.status(202).json({ id });
  void withApiConnections({},()=>generate(input, run, controller.signal, log))
    .then(async () => {
      if (controller.signal.aborted) {
        run.status = "cancelled";
        return;
      }
      log("export", "complete", "Editable object document ready");
      if (run.scene) {
        const dir = outputPath('runs', id);
        await mkdir(dir, { recursive: true });
        await Promise.all([
          writeFile(
            join(dir, "project.json"),
            JSON.stringify(run.scene, null, 2),
          ),
          writeFile(join(dir, "figure.svg"), sceneSvg(run.scene)),
          writeFile(join(dir, "figure.png"), pngForScene(run.scene)),
        ]);
        await writeFile(
          join(dir, "checkpoint.json"),
          JSON.stringify({ ...run, status: "complete" }, null, 2),
        );
      }
      run.status = "complete";
    })
    .catch(async (e) => {
      run.status = controller.signal.aborted ? "cancelled" : "error";
      run.error = String(e);
      log("pipeline", "error", String(e));
      try {
        const dir = outputPath('runs', id);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "checkpoint.json"),
          JSON.stringify(run, null, 2),
        );
      } catch (saveError) {
        log(
          "pipeline",
          "warning",
          `Failed to save the recovery checkpoint: ${String(saveError)}`,
        );
      }
    })
    .finally(() => controllers.delete(id));
});
app.get("/api/runs/:id", async (req, res) => {
  const run = runs.get(String(req.params.id));
  if (run) return res.json(run);
  if (!/^[a-f0-9-]{36}$/.test(String(req.params.id)))
    return res.status(400).json({ error: "Invalid run id" });
  try {
    res.json(
      JSON.parse(
        await readFile(
          outputPath('runs', String(req.params.id), 'checkpoint.json'),
          "utf8",
        ),
      ),
    );
  } catch {
    res.status(404).json({ error: "Run not found" });
  }
});
app.post("/api/runs/:id/cancel", (req, res) => {
  controllers.get(String(req.params.id))?.abort();
  const run = runs.get(String(req.params.id));
  if (run) run.status = "cancelled";
  res.json({ ok: true });
});
app.post("/api/render", (req, res) => {
  try {
    const scene = req.body as FigureScene;
    if (scene?.schema !== "paper-atelier/1") throw Error("Invalid project");
    res.type("image/png").send(pngForScene(scene));
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
app.use("/references", express.static(resolve("public", "references")));
app.use(express.static(resolve("dist")));
app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist", "index.html")));
app.listen(port, "127.0.0.1", () =>
  console.log(`Paper Studio ready at http://localhost:${port}`),
);

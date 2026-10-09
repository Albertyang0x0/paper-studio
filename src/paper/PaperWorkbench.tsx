import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Download,
  FileText,
  ExternalLink,
  FolderOpen,
  History,
  Image as ImageIcon,
  Layers3,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  StopCircle,
  Unlock,
  Upload,
  X,
} from "lucide-react";
import type {
  Candidate,
  FigureAsset,
  MethodDefinition,
  ModuleId,
  PaperMaterial,
  PaperProject,
  PaperRun,
  PaperTemplate,
} from "../../shared/paper-types";
import { runFailureMessage, runStatusLabel } from '../../shared/paper-run';
import {
  moduleDependencies,
  moduleLabels,
  moduleOrder,
} from "../../shared/paper-types";
import { lineDiff, scientificRiskWarnings } from "../../shared/paper-project";
import type { FigureScene } from "../../shared/types";
import "./paper.css";
import { readTemplateFiles } from './template-upload';
import { PaperInputs } from './PaperInputs';
import {defaultMethod} from '../../shared/paper-methods';
import { ApiSettingsButton } from '../settings/ApiSettings';
import { useApiSettingsUpdates } from '../settings/api-settings-events';
import { ConnectionSelect, useConnectionSettings } from '../settings/ConnectionSelect';

const Preview = lazy(() => import("./PaperPreview"));
const PdfPreview = lazy(() => import('./PaperPdfPreview'));
const uid = () => crypto.randomUUID();
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error ?? r.statusText);
  return data;
}
const roleLabel = {
  idea: "Idea",
  experiment: "Experiment",
  context: "背景材料",
};
type SourceForm = {
  title: string;
  ideaSpark: string;
  language: "en" | "zh";
  guidelines: string;
  materials: PaperMaterial[];
  expectedSourceRevision?: number;
  template?: PaperTemplate;
};
const emptyForm = (): SourceForm => ({
  title: "",
  ideaSpark: "",
  language: "en",
  guidelines:
    "Anonymized ML research draft. Ground scientific claims in supplied evidence; disclose limitations and missing results.",
  materials: [],
});
function formFor(p: PaperProject): SourceForm {
  return {
    title: p.title,
    ideaSpark: p.ideaSpark,
    language: p.language,
    guidelines: p.guidelines,
    materials: structuredClone(p.materials),
    template: p.template ? structuredClone(p.template) : undefined,
    expectedSourceRevision: p.sourceRevision,
  };
}
function Render({ text, project }: { text: string; project?: PaperProject }) {
  return (
    <Suspense fallback={<p className="pw-muted">正在载入排版…</p>}>
      <Preview content={text} project={project} />
    </Suspense>
  );
}

export default function PaperWorkbench() {
  const [projects, setProjects] = useState<
    { id: string; title: string; revision: number }[]
  >([]);
  const [project, setProjectState] = useState<PaperProject>();
  // A slow poll must never replace a newer mutation response from the same project.
  function setProject(incoming: PaperProject) {
    setProjectState((previous) =>
      previous?.id === incoming.id && previous.revision > incoming.revision
        ? previous
        : incoming,
    );
  }
  const [selected, setSelected] = useState<ModuleId>("introduction");
  const connectionSettings=useConnectionSettings();
  const [connectionId,setConnectionId]=useState(''),[imageConnectionId,setImageConnectionId]=useState(''),[imageModel,setImageModel]=useState('');
  const [view, setView] = useState<"edit" | "preview" | "history" | "canvas">(
    "edit",
  );
  const [editor, setEditor] = useState(""),
    [methodId, setMethodId] = useState("grounded-section"),
    [model, setModel] = useState("");
  const [methods, setMethods] = useState<MethodDefinition[]>([]),
    [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<{
    configured: boolean;
    model: string;
    pdfAvailable: boolean;
    connectivity?: { testedAt: string; records: { model: string; ok: boolean; status?: number; error?: string }[] };
  }>();
  const [run, setRun] = useState<PaperRun>(),
    [runId, setRunId] = useState(""),
    [runPollVersion, setRunPollVersion] = useState(0);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [sourceMode, setSourceMode] = useState<"new" | "edit" | undefined>(),
    [form, setForm] = useState<SourceForm>(emptyForm);
  const [candidateId, setCandidateId] = useState(""),
    [candidateView, setCandidateView] = useState<"diff" | "preview">("diff");
  const [candidateDraft,setCandidateDraft]=useState<{id:string;content:string}>();
  const [skipReferences, setSkipReferences] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false);
  const [figureSubmission, setFigureSubmission] = useState<{
    scene: FigureScene;
    caption: string;
    previousAssetId?: string;
  }>();
  const [citationForm, setCitationForm] = useState<{
    id?: string;
    title: string;
    authors: string;
    year: string;
    url: string;
    abstract: string;
  }>();
  const projectRef = useRef(project);
  const navigation = useRef(0);
  projectRef.current = project;
  const frame = useRef<HTMLIFrameElement>(null),
    importProject = useRef<HTMLInputElement>(null);
  const figureBase = useRef<
    | {
        revision: number;
        sourceRevision: number;
        dependencies: Partial<Record<ModuleId, number>>;
        previousAssetId?: string;
      }
    | undefined
  >(undefined);
  const nextCanvasAsset = useRef<FigureAsset | null | undefined>(undefined);
  const active = project?.modules[selected],
    dirty = !!active && editor !== active.content;
  const textConnection=connectionSettings?.connections.find(c=>c.id===(connectionId||connectionSettings.defaultConnectionId));
  const imageConnection=connectionSettings?.connections.find(c=>c.id===(imageConnectionId||connectionSettings.defaultImageConnectionId));
  const currentWarnings = [
    ...new Set([
      ...(active?.history.at(-1)?.warnings ?? []),
      ...scientificRiskWarnings(active?.content ?? ""),
    ]),
  ];
  const availableMethods = methods.filter((m) => m.modules.includes(selected));
  const chosenMethod =
    availableMethods.find((m) => m.id === methodId) ?? availableMethods[0];
  const pending =
    project?.candidates.filter((c) => c.status === "pending") ?? [];
  const candidates = pending.filter((c) => c.moduleId === selected).reverse();
  const candidate =
    candidates.find((c) => c.id === candidateId) ?? candidates[0];
  const diff = useMemo(
    () =>
      candidate && active ? lineDiff(active.content, candidate.content) : [],
    [active?.content, candidate?.id],
  );
  const latestBatch = pending
    .slice()
    .reverse()
    .find((c) => pending.filter((v) => v.runId === c.runId).length > 1)?.runId;
  const batch = pending.filter((c) => c.runId === latestBatch);
  const projectRun = run?.projectId === project?.id ? run : undefined;
  const generating = projectRun?.status === "running";
  useApiSettingsUpdates(settings => {
    setStatus(previous => previous ? { ...previous, configured: settings.configured } : previous);
  });

  async function refreshList() {
    const data = await api<{ projects: typeof projects }>("/api/papers");
    setProjects(data.projects);
    return data.projects;
  }
  async function openProject(id: string) {
    const token = ++navigation.current;
    const p = await api<PaperProject>("/api/papers/" + id);
    if (token !== navigation.current) return;
    setProject(p);
    localStorage.setItem("paper-workbench-active", id);
    setCandidateId("");
    const history=await api<{runs:PaperRun[]}>(`/api/papers/${id}/runs`).catch(()=>({runs:[]}));
    if(token!==navigation.current)return;
    const latest=history.runs[0];setRun(latest);setRunId(latest?.id??'');
  }
  async function action(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void api<any>("/api/workbench/status")
      .then((s) => {
        setStatus(s);
        setModel(s.model);
      })
      .catch((e) => setError(String(e)));
    void api<any>("/api/paper-methods")
      .then((s) => setMethods(s.methods))
      .catch((e) => setError(String(e)));
    void refreshList()
      .then(async (items) => {
        if (navigation.current || projectRef.current) return;
        const saved = localStorage.getItem("paper-workbench-active");
        const requested = new URLSearchParams(location.search).get("project");
        const id =
          items.find((p) => p.id === requested)?.id ??
          items.find((p) => p.id === saved)?.id ??
          items[0]?.id;
        if (id) await openProject(id);
      })
      .catch((e) => setError(String(e)));
    const savedRun = localStorage.getItem("paper-workbench-run");
    if (savedRun) setRunId(savedRun);
  }, []);
  useEffect(() => {
    if (project?.id)
      history.replaceState(
        null,
        "",
        "/?project=" + encodeURIComponent(project.id),
      );
  }, [project?.id]);
  useEffect(() => {
    setEditor(active?.content ?? "");
    setMethodId(
      active?.methodId === "manual"
        ? defaultMethod(selected)
        : (active?.methodId ?? defaultMethod(selected)),
    );
    setCandidateId("");
  }, [project?.id, selected, active?.revision, active?.methodId]);
  useEffect(() => {
    setModel(connectionId!==(active?.connectionId||'') ? textConnection?.textModel||'' : active?.model || textConnection?.textModel || status?.model || "");
  }, [project?.id, selected, active?.model, status?.model,connectionId,textConnection?.textModel,active?.connectionId]);
  useEffect(()=>{setConnectionId(active?.connectionId||'');setImageConnectionId(active?.imageConnectionId||'');},[project?.id,selected,active?.connectionId,active?.imageConnectionId]);
  useEffect(()=>{setImageModel(imageConnectionId!==(active?.imageConnectionId||'') ? imageConnection?.imageModel||'' : active?.imageModel||imageConnection?.imageModel||'');},[project?.id,selected,active?.imageModel,imageConnectionId,imageConnection?.imageModel,active?.imageConnectionId]);
  async function saveMethodConfiguration(nextMethod = methodId) {
    if (!project) return;
    await action(async () =>
      setProject(
        await api<PaperProject>(
          `/api/papers/${project.id}/modules/${selected}/method`,
          { methodId: nextMethod, model,connectionId,imageConnectionId,imageModel },
        ),
      ),
    );
  }
  useEffect(() => {
    if (!runId) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<PaperRun>("/api/paper-runs/" + runId);
        if (stopped) return;
        setRun(r);
        if (projectRef.current?.id === r.projectId) {
          const p = await api<PaperProject>("/api/papers/" + r.projectId);
          if (!stopped && projectRef.current?.id === p.id) setProject(p);
        }
        if (r.status === "running") timer = setTimeout(poll, 1300);
        else {
          localStorage.removeItem("paper-workbench-run");
          if (r.error) setError(runFailureMessage(r.error));
          if (r.status === "complete")
            setMessage("生成完成");
          if (r.status === 'partial') setMessage('正文候选已保存，绘图待重试');
        }
      } catch (e) {
        if (!stopped) {
          setError(String(e));
          timer = setTimeout(poll, 4000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, runPollVersion]);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 7000);
    return () => clearTimeout(t);
  }, [message]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      if (event.data?.type === "paper-workbench:figure-ready") {
        sendToCanvas(nextCanvasAsset.current);
        nextCanvasAsset.current = undefined;
      }
      if (
        event.data?.type === "paper-workbench:figure-submit" &&
        event.data.scene?.schema === "paper-atelier/1"
      ) {
        const p = projectRef.current,
          previous = p ? [...p.assets,...p.candidates.filter(c=>c.status==='pending').flatMap(c=>c.assets??[])].find(
            (a) => a.id === figureBase.current?.previousAssetId,
          ) : undefined;
        setFigureSubmission({
          scene: event.data.scene,
          caption: previous?.caption ?? event.data.scene.title,
          previousAssetId: previous?.id,
        });
      }
      if (event.data?.type === "paper-workbench:figure-error")
        setError(String(event.data.message));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  function sendToCanvas(asset?: FigureAsset | null) {
    const p = projectRef.current;
    if (!p || !frame.current?.contentWindow) return;
    const current =
      asset === null
        ? undefined
        : (asset ??
          p.assets.find((a) => a.id === p.modules.figures.assetIds[0]) ??
          p.candidates.filter(c=>c.moduleId==='figures'&&c.status==='pending').at(-1)?.assets?.[0]);
    figureBase.current = {
      revision: p.modules.figures.revision,
      sourceRevision: p.sourceRevision,
      dependencies: {
        method: p.modules.method.revision,
        experiments: p.modules.experiments.revision,
      },
      previousAssetId: current?.id,
    };
    const ideaAlreadyIncluded=p.materials.some(m=>m.role==='idea'&&m.content.trim()===p.ideaSpark.trim());
    const materials = [
      ...(!ideaAlreadyIncluded ? [{ id: "idea-spark", name: "idea_spark.md", content: p.ideaSpark }] : []),
      ...p.materials,
    ].filter((m) => m.content.trim());
    frame.current.contentWindow.postMessage(
      {
        type: "paper-workbench:load-figure",
        scene: current?.scene ?? null,
        materials,
        intent:
          "Create a methodology overview grounded in the supplied materials. Describe the actual proposed mechanism and its modules. Do not invent experimental curves, improvements or evidence.",
      },
      location.origin,
    );
  }
  function switchModule(id: ModuleId) {
    if (dirty && !confirm("当前有未保存的文字，切换会放弃这些文字。要继续吗？"))
      return;
    setSelected(id);
    setView(id === "figures" ? "canvas" : "edit");
    setInstruction("");
    setError("");
  }
  async function save() {
    if (!project || !active) return;
    await action(async () => {
      setProject(
        await api<PaperProject>(
          `/api/papers/${project.id}/modules/${selected}`,
          { expectedRevision: active.revision, content: editor },
        ),
      );
      setMessage("已保存");
    });
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !busy) void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dirty, busy, project?.id, active?.revision, editor]);
  async function startGeneration(
    mode: "module" | "draft",
    resumeRunId?: string,
  ) {
    if (!project || !chosenMethod) return;
    if (dirty) {
      setError("请先保存手动编辑，再生成候选。");
      return;
    }
    await action(async () => {
      const r = await api<PaperRun>("/api/paper-runs", {
        projectId: project.id,
        expectedRevision: project.revision,
        moduleId: selected,
        mode,
        resumeRunId,
        methodId: chosenMethod.id,
        model,
        connectionId,
        instruction,
        models: Object.fromEntries(
          moduleOrder.map((id) => [id, project.modules[id].model || connectionSettings?.connections.find(c=>c.id===(project.modules[id].connectionId||connectionSettings.defaultConnectionId))?.textModel || status?.model]),
        ),
        connections:Object.fromEntries(moduleOrder.map(id=>[id,project.modules[id].connectionId||''])),
        imageConnections:Object.fromEntries(moduleOrder.map(id=>[id,project.modules[id].imageConnectionId||''])),
        imageModels:Object.fromEntries(moduleOrder.map(id=>[id,project.modules[id].imageModel||''])),
        methods: Object.fromEntries(
          moduleOrder.map((id) => [
            id,
            project.modules[id].methodId === "manual"
              ? defaultMethod(id)
              : project.modules[id].methodId,
          ]),
        ),
        skipReferenceSearch: skipReferences,
      });
      setRun(r);
      setRunId(r.id);
      setRunPollVersion(version => version + 1);
      localStorage.setItem("paper-workbench-run", r.id);
      setMessage("生成已开始");
    });
  }
  async function accept(ids: string[], isBatch = false) {
    if (!project) return;
    if (dirty) {
      setError("请先保存当前编辑。");
      return;
    }
    await action(async () => {
      setProject(
        await api<PaperProject>(`/api/papers/${project.id}/candidates/accept`, {
          ids,
          batch: isBatch,
        }),
      );
      setCandidateId("");
      setMessage(
        isBatch
          ? "已接受整篇候选"
          : "已接受候选",
      );
    });
  }
  async function importMaterial(file: File, role: 'idea' | 'experiment') {
    if (file.size > 1_000_000) throw Error('材料文件不能超过 1 MB。');
    const material: PaperMaterial = { id: uid(), name: file.name, role, content: await file.text() };
    setForm(f => ({ ...f, ideaSpark: role === 'idea' ? material.content : f.ideaSpark,
      materials: [...f.materials.filter(m => m.role !== role), material] }));
  }
  async function submitSources() {
    await action(async () => {
      const p = await api<PaperProject>(
        sourceMode === "edit" && project
          ? `/api/papers/${project.id}/materials`
          : "/api/papers",
        { ...form, expectedRevision: project?.revision },
      );
      navigation.current++;
      setProject(p);
      // Keep the controlled selector valid before the asynchronous list refresh.
      // Otherwise the DOM can briefly report another project's first option.
      setProjects(items => [{ id: p.id, title: p.title, revision: p.revision }, ...items.filter(item => item.id !== p.id)]);
      localStorage.setItem("paper-workbench-active", p.id);
      setSourceMode(undefined);
      await refreshList();
      setMessage("材料已保存");
    });
  }
  async function download(format: string) {
    if (!project) return;
    setExportOpen(false);
    await action(async () => {
      const r = await fetch(`/api/papers/${project.id}/export/${format}`);
      if (!r.ok) throw Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = `paper-${project.id}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    });
  }
  const written = project
    ? Object.values(project.modules).filter((m) => m.content.trim()).length
    : 0;
  return (
    <div className={"pw-app " + (view === "canvas" && selected === "figures" ? "pw-canvas-active" : "")}>
      <header className="pw-header">
        <div className="pw-brand">
          <span>
            <BookOpen size={20} />
          </span>
          <div>
            <strong>Paper Studio</strong>
          </div>
        </div>
        <div className="pw-header-actions">
          <ApiSettingsButton className="pw-button" />
          <span
            className={"pw-connection " + (status?.configured ? "ready" : "")}
          >
            {status?.configured
              ? "模型 API 已配置"
              : "API 未配置"}
          </span>
          <button
            className="pw-icon"
            aria-label="使用帮助"
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={18} />
          </button>
          <button
            className="pw-button"
            onClick={() => importProject.current?.click()}
          >
            <FolderOpen size={15} /> 导入项目
          </button>
          {project && (
            <div className="pw-dropdown">
              <button
                className="pw-button"
                onClick={() => setExportOpen(!exportOpen)}
              >
                <Download size={15} /> 导出项目
              </button>
              {exportOpen && (
                <div className="pw-menu">
                  {[
                    ["json", "可移植项目 · JSON"],
                    ["md", "全文 · Markdown"],
                    ["tex", "论文源稿 · LaTeX"],
                    ["zip", "论文源文件 · ZIP"],
                    ["bib", "引用库 · BibTeX"],
                  ].map(([format, name]) => (
                    <button key={format} onClick={() => void download(format)}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            className="pw-button pw-primary"
            onClick={() => {
              setForm(emptyForm());
              setSourceMode("new");
            }}
          >
            <Plus size={16} /> 新建研究
          </button>
        </div>
      </header>
      <input
        type="file"
        accept=".json"
        hidden
        ref={importProject}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f)
            void action(async () => {
              const p = await api<PaperProject>("/api/papers/import", {
                project: JSON.parse(await f.text()),
              });
              setProject(p);
              localStorage.setItem("paper-workbench-active", p.id);
              await refreshList();
            });
          e.target.value = "";
        }}
      />
      {error && (
        <div className="pw-banner error" role="alert">
          <ShieldCheck size={16} />
          <span>{error}</span>
          <button aria-label="关闭错误" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {message && (
        <div className="pw-banner success" role="status">
          <Check size={16} />
          <span>{message}</span>
          <button onClick={() => setMessage("")} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
      {!project ? (
        <main className="pw-welcome">
          <div className="pw-welcome-copy">
            <h1>新建论文</h1>
            <p>上传论文模板、idea 和 experiment。</p>
            <button
              className="pw-button pw-primary pw-large"
              onClick={() => {
                setForm(emptyForm());
                setSourceMode("new");
              }}
            >
              新建项目 <Plus size={18} />
            </button>
          </div>
        </main>
      ) : (
        <main
          className={"pw-layout " + (view === "canvas" ? "canvas-mode" : "")}
        >
          <aside className="pw-sidebar">
            <label className="pw-eyebrow">项目</label>
            <select
              aria-label="选择论文项目"
              value={project.id}
              onChange={(e) => {
                if (!dirty || confirm("切换项目将放弃未保存文字，继续吗？"))
                  void action(() => openProject(e.target.value));
              }}
            >
              <option value={project.id}>{project.title}</option>
              {projects
                .filter((p) => p.id !== project.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
            </select>
            <button
              className="pw-source-card"
              onClick={() => {
                setForm(formFor(project));
                setSourceMode("edit");
              }}
            >
              <div>
                <FileText size={17} />
                <strong>研究材料</strong>
                <Settings2 size={13} />
              </div>
              <p>
                {project.ideaSpark ||
                  project.materials.find((m) => m.role === "idea")?.content ||
                  "点击管理材料"}
              </p>
              <span>
                {project.materials.length} 个文件 ·{" "}
                {project.materials.some((m) => m.role === "experiment")
                  ? "包含实验材料"
                  : "尚无实验记录"}
              </span>
            </button>
            <div className="pw-sidebar-label">
              <span>论文模块</span>
              <span>
                {written}/{moduleOrder.length}
              </span>
            </div>
            <nav className="pw-module-nav">
              {moduleOrder.map((id, i) => {
                const m = project.modules[id],
                  count = pending.filter((c) => c.moduleId === id).length;
                return (
                  <button
                    className={selected === id ? "active" : ""}
                    key={id}
                    onClick={() => switchModule(id)}
                    data-module={id}
                  >
                    <span className="pw-module-num">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>
                      {moduleLabels[id]}
                      <small>
                        {m.needsSync.length
                          ? "依赖有更新"
                          : m.content
                            ? "主稿已写入"
                            : "尚未写入"}
                      </small>
                    </span>
                    {m.locked ? (
                      <Lock size={13} />
                    ) : count ? (
                      <b>{count}</b>
                    ) : m.content ? (
                      <span className="pw-dot" />
                    ) : (
                      <span className="pw-empty-dot" />
                    )}
                  </button>
                );
              })}
            </nav>
          </aside>
          <section className="pw-main">
            <div className="pw-project-head">
              <div>
                <span className="pw-eyebrow">
                  版本 {project.revision}
                </span>
                <h1>{project.title}</h1>
                <p>
                  {project.language === "en"
                    ? "English manuscript"
                    : "中文主稿"}{" "}
                  <span>·</span> {project.citations.length} 条引用{" "}
                  <span>·</span> {project.modules.figures.assetIds.length} 张图
                </p>
              </div>
              <div className="pw-draft-action">
                <button
                  className="pw-button pw-primary"
                  disabled={busy || generating || !(status?.configured||textConnection?.configured) || dirty}
                  onClick={() => void startGeneration("draft")}
                >
                  <Sparkles size={16} /> 生成整篇候选
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={skipReferences}
                    onChange={(e) => setSkipReferences(e.target.checked)}
                  />{" "}
                  跳过文献检索
                </label>
              </div>
            </div>
            {batch.length > 1 && (
              <div className="pw-batch">
                <div>
                  <Layers3 size={18} />
                  <span>
                    一批初稿已就绪{" "}
                    <small>
                      {batch.length} 个候选待确认
                    </small>
                  </span>
                </div>
                <button
                  className="pw-button"
                  disabled={busy || dirty || generating}
                  onClick={() =>
                    void accept(
                      batch.map((c) => c.id),
                      true,
                    )
                  }
                >
                  接受整批候选 <ArrowRight size={14} />
                </button>
              </div>
            )}
            <div className="pw-document-bar">
              <div className="pw-document-tabs">
                {[
                  ["edit", "章节编辑"],
                  ["preview", "全文预览"],
                  ["history", "版本历史"],
                  ...(selected === "figures" ? [["canvas", "矢量画板"]] : []),
                ].map(([id, title]) => (
                  <button
                    key={id}
                    className={view === id ? "active" : ""}
                    onClick={() => setView(id as typeof view)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              {view === "canvas" && selected === "figures" ? <div className="pw-canvas-switcher">
                  <select
                    aria-label="选择画板中的图"
                    defaultValue="current"
                    onChange={(e) => {
                      if (!confirm("切换画板会放弃未提交的编辑，继续吗？"))
                        return;
                      sendToCanvas(
                        e.target.value === "new"
                          ? null
                          : [...project.assets,...pending.flatMap(c=>c.assets??[])].find((a) => a.id === e.target.value),
                      );
                    }}
                  >
                    <option value="current">当前图 / 第一张图</option>
                    {project.modules.figures.assetIds.map((id) => {
                      const a = project.assets.find((v) => v.id === id)!;
                      return (
                        <option key={id} value={id}>
                          {a.title}
                        </option>
                      );
                    })}
                    {!!pending.flatMap(c=>c.assets??[]).length && <optgroup label="候选图">
                      {pending.flatMap(c=>c.assets??[]).map(a=><option key={a.id} value={a.id}>{a.title}</option>)}
                    </optgroup>}
                    <option value="new">＋ 新建另一张图</option>
                  </select>
                  <a
                    href={`/figure?paper=${project.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="pw-canvas-standalone"
                    title="独立画板（仅导出）"
                    aria-label="独立画板（仅导出）"
                  >
                    <ExternalLink size={16} />
                  </a>

              </div> : <span>
                {dirty ? "● 未保存" : `模块 v${active?.revision}`}{" "}
                {active?.locked && "· 已锁定"}
              </span>}
            </div>
            {view === "canvas" && selected === "figures" ? (
              <div className="pw-canvas-wrap">
                <iframe
                  title="论文矢量画板"
                  ref={frame}
                  src={`/figure?paper=${project.id}`}
                />
              </div>
            ) : view === "preview" ? (
              <Suspense fallback={<div className="pw-pdf-state">正在载入预览…</div>}>
                <PdfPreview key={project.id} project={project} available={status?.pdfAvailable} />
              </Suspense>
            ) : view === "history" ? (
              <div className="pw-document-scroll">
                <div className="pw-section-title">
                  <History size={19} />
                  <h2>{moduleLabels[selected]} · 版本历史</h2>
                </div>
                <p className="pw-muted">
                  恢复会产生新版本，不删除后续历史；图表恢复包含对应对象模型。
                </p>
                {active?.history
                  .slice()
                  .reverse()
                  .map((version) => (
                    <details className="pw-version" key={version.revision}>
                      <summary>
                        <span>
                          v{version.revision} · {version.reason}
                          <small>
                            {new Date(version.createdAt).toLocaleString()} ·{" "}
                            {version.methodId}
                          </small>
                        </span>
                        <button
                          className="pw-button"
                          disabled={
                            busy ||
                            dirty ||
                            version.revision === active.revision
                          }
                          onClick={(e) => {
                            e.preventDefault();
                            void action(async () => {
                              setProject(
                                await api<PaperProject>(
                                  `/api/papers/${project.id}/modules/${selected}/restore`,
                                  {
                                    expectedRevision: active.revision,
                                    revision: version.revision,
                                  },
                                ),
                              );
                              setMessage(
                                "已恢复为新版本，其他模块正文未修改。",
                              );
                            });
                          }}
                        >
                          恢复此版本
                        </button>
                      </summary>
                      <div className="pw-prose">
                        <Render
                          text={version.content || "空版本"}
                          project={project}
                        />
                      </div>
                    </details>
                  ))}
              </div>
            ) : (
              <div className="pw-document-scroll">
                <div className="pw-section-title">
                  <div>
                    <h2>{moduleLabels[selected]}</h2>
                  </div>
                  <button
                    className="pw-button"
                    title="锁定阻止 AI 生成与候选替换，仍可手动编辑"
                    onClick={() =>
                      void action(async () =>
                        setProject(
                          await api<PaperProject>(
                            `/api/papers/${project.id}/modules/${selected}/lock`,
                            { locked: !active?.locked },
                          ),
                        ),
                      )
                    }
                  >
                    {active?.locked ? <Unlock size={14} /> : <Lock size={14} />}
                    {active?.locked ? "解锁模块" : "锁定模块"}
                  </button>
                  <button
                    className="pw-button pw-primary"
                    disabled={!dirty || busy}
                    onClick={() => void save()}
                  >
                    <Save size={14} /> 保存到主稿
                  </button>
                </div>
                {!!active?.needsSync.length && (
                  <div className="pw-notice">
                    以下依赖已更新：
                    {active.needsSync
                      .map((id) => moduleLabels[id as ModuleId] ?? "研究材料")
                      .join("、")}
                    。当前正文未被自动改写。
                  </div>
                )}
                {!!currentWarnings.length && (
                  <details className="pw-warnings">
                    <summary>当前主稿版本的待核验事项</summary>
                    <ul>
                      {currentWarnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <textarea
                  className="pw-editor"
                  aria-label="当前模块内容"
                  value={editor}
                  readOnly={
                    (selected === "figures" && !!active?.assetIds.length) ||
                    (selected === "references" && !!project.citations.length)
                  }
                  onChange={(e) => setEditor(e.target.value)}
                  placeholder={
                    selected === "references"
                      ? "在右侧检索引用，或下方手动登记真实文献。引用格式为 [@citation_key]。"
                      : "在这里亲自写作，或在右侧选择一种方法生成候选。支持 Markdown、公式和表格。"
                  }
                  spellCheck={false}
                />
                <div className="pw-editor-foot">
                  <span>Markdown · $公式$ · 表格 · [@引用键]</span>
                  <span>
                    {editor.length.toLocaleString()} 字符 · Ctrl / ⌘ + S 保存
                  </span>
                </div>
                {selected === "figures" && !!active?.assetIds.length && (
                  <div className="pw-citation-library">
                    <p className="pw-muted">
                      图表概览由对象与图注生成。以下操作只修改选中的图，不覆盖其他图。
                    </p>
                    {active.assetIds.map((id) => {
                      const a = project.assets.find(
                        (asset) => asset.id === id,
                      )!;
                      return (
                        <div className="pw-citation" key={id}>
                          <strong>
                            {a.title} · 图版本 v{a.version}
                          </strong>
                          <small>{a.caption}</small>
                          <div>
                            <button
                              className="pw-button"
                              onClick={() => {
                                figureBase.current = {
                                  revision: active.revision,
                                  sourceRevision: project.sourceRevision,
                                  dependencies: {
                                    method: project.modules.method.revision,
                                    experiments:
                                      project.modules.experiments.revision,
                                  },
                                  previousAssetId: a.id,
                                };
                                setFigureSubmission({
                                  scene: a.scene,
                                  caption: a.caption,
                                  previousAssetId: a.id,
                                });
                              }}
                            >
                              修改这张图的图注
                            </button>{" "}
                            <button
                              className="pw-button"
                              onClick={() => {
                                nextCanvasAsset.current = a;
                                setView("canvas");
                              }}
                            >
                              编辑矢量对象
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {selected === "references" && (
                  <div className="pw-citation-library">
                    <div>
                      <h3>共享引用库</h3>
                      <button
                        className="pw-button"
                        onClick={() =>
                          setCitationForm({
                            title: "",
                            authors: "",
                            year: "",
                            url: "",
                            abstract: "",
                          })
                        }
                      >
                        <Plus size={14} /> 手动登记文献
                      </button>
                    </div>
                    {project.citations.map((c) => (
                      <div className="pw-citation" key={c.id}>
                        <strong>{c.title}</strong>
                        <code>[@{c.key}]</code>
                        <button
                          className="pw-button"
                          onClick={() =>
                            setCitationForm({
                              id: c.id,
                              title: c.title,
                              authors: c.authors.join(", "),
                              year: String(c.year ?? ""),
                              url: c.url,
                              abstract: c.abstract,
                            })
                          }
                        >
                          修改文献信息
                        </button>
                        <small>
                          {c.year ?? "n.d."} · {c.provider} ·{" "}
                          {c.verification === "metadata-verified"
                            ? "仅元数据已核验"
                            : "用户提供，未在线核验"}
                        </small>
                      </div>
                    ))}
                  </div>
                )}
                {candidate && (
                  <section className="pw-candidate">
                    <header>
                      <div>
                        <span className="pw-eyebrow">
                          {candidate.model}
                        </span>
                        <h3>候选版本</h3>
                      </div>
                      <select
                        aria-label="选择候选版本"
                        value={candidate.id}
                        onChange={(e) => setCandidateId(e.target.value)}
                      >
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {new Date(c.createdAt).toLocaleTimeString()} ·{" "}
                            {methods.find((m) => m.id === c.methodId)?.name ??
                              c.methodId}
                          </option>
                        ))}
                      </select>
                    </header>
                    <div className="pw-candidate-tabs">
                      <button
                        className={candidateView === "diff" ? "active" : ""}
                        onClick={() => setCandidateView("diff")}
                      >
                        差异
                      </button>
                      <button
                        className={candidateView === "preview" ? "active" : ""}
                        onClick={() => setCandidateView("preview")}
                      >
                        候选预览
                      </button>
                      <span>基于模块 v{candidate.baseRevision}</span>
                      {!['figures','references'].includes(selected)&&<button disabled={busy||generating} onClick={()=>setCandidateDraft({id:candidate.id,content:candidate.content})}>编辑候选</button>}
                    </div>
                    {candidateView === "diff" ? (
                      <div className="pw-diff">
                        {diff.map((line, i) => (
                          <div key={i} className={line.kind}>
                            <span>
                              {line.kind === "add"
                                ? "+"
                                : line.kind === "remove"
                                  ? "−"
                                  : " "}
                            </span>
                            <code>{line.text || " "}</code>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="pw-prose">
                        <Render text={candidate.content} project={project} />
                      </div>
                    )}
                    {candidate.assets?.map((a) => (
                      <div className="pw-candidate-figure" key={a.id}>
                        <img src={`/api/papers/${project.id}/assets/${a.id}.svg`} alt={a.title} />
                        <strong>{a.title}</strong>
                        <p>
                          包含原生矢量对象 · {a.scene.modules.length}{" "}
                          个绘图子模块
                        </p>
                        <button
                          className="pw-button"
                          disabled={generating}
                          onClick={() => {
                            nextCanvasAsset.current = a;
                            setView("canvas");
                          }}
                        >
                          继续编辑画板候选
                        </button>
                      </div>
                    ))}
                    {!!candidate.warnings.length && (
                      <details className="pw-warnings" open>
                        <summary>
                          需确认的检查结果 · {candidate.warnings.length}
                        </summary>
                        <ul>
                          {candidate.warnings.map((warning, i) => (
                            <li key={i}>{warning}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <footer>
                      <button
                        className="pw-button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () =>
                            setProject(
                              await api<PaperProject>(
                                `/api/papers/${project.id}/candidates/${candidate.id}/reject`,
                                {},
                              ),
                            ),
                          )
                        }
                      >
                        不采用，保留主稿
                      </button>
                      <button
                        className="pw-button pw-primary"
                        disabled={busy || dirty || active?.locked}
                        onClick={() => void accept([candidate.id])}
                      >
                        <Check size={15} /> 接受并替换此模块
                      </button>
                    </footer>
                  </section>
                )}
              </div>
            )}
          </section>
          <aside className="pw-method-panel">
            <h2>生成设置</h2>
            <label>选择方法</label>
            <select
              aria-label="模块方法"
              value={chosenMethod?.id ?? ""}
              disabled={busy || generating}
              onChange={(e) => {
                setMethodId(e.target.value);
                void saveMethodConfiguration(e.target.value);
              }}
            >
              {availableMethods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {chosenMethod && (
              <div className="pw-method-card">
                <details>
                <summary>执行步骤</summary>
                <ol>
                  {chosenMethod.stages.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                  {chosenMethod.source && (
                    <a
                      href={chosenMethod.source}
                      target="_blank"
                      rel="noreferrer"
                    >
                      源码 ↗
                    </a>
                  )}
                </details>
              </div>
            )}
            <label>API 连接</label>
            <ConnectionSelect settings={connectionSettings} value={connectionId} label="模块 API 连接" disabled={busy||generating} onChange={setConnectionId}/>
            {selected==='figures'&&<>
              <label>文本模型 ID</label><input aria-label="图表文本模型" value={model} onChange={e=>setModel(e.target.value)} disabled={busy||generating}/>
              <label>图片 API 连接</label><ConnectionSelect settings={connectionSettings} value={imageConnectionId} kind="image" label="图表图片 API 连接" disabled={busy||generating} onChange={setImageConnectionId}/>
              <label>图片模型 ID</label><input aria-label="图表图片模型" value={imageModel} onChange={e=>setImageModel(e.target.value)} disabled={busy||generating}/>
              <button className="pw-button pw-wide" disabled={busy||generating||!model} onClick={()=>void saveMethodConfiguration()}>保存配置</button>
            </>}
            {selected !== "figures" ? (
              <>
                <label>模型 ID</label>
                <input
                  aria-label="写作模型"
                  list="pw-writing-models"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="该连接的模型 ID"
                />
                <datalist id="pw-writing-models">
                  {textConnection?.textModel&&<option value={textConnection.textModel} />}
                  {textConnection?.protocol==='openrouter'&&<>
                    <option value="google/gemini-3.1-pro-preview" />
                    <option value="google/gemma-4-31b-it" />
                  </>}
                </datalist>
                <button
                  className="pw-button pw-wide"
                  disabled={busy || generating || !chosenMethod || !model}
                  onClick={() => void saveMethodConfiguration(chosenMethod?.id)}
                >
                  保存配置
                </button>
                <label>本次修改要求</label>
                <textarea
                  aria-label="生成要求"
                  rows={4}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="输入修改要求"
                />
                <button
                  className="pw-button pw-primary pw-wide"
                  disabled={
                    busy ||
                    generating ||
                    !status?.configured ||
                    active?.locked ||
                    dirty ||
                    !model
                  }
                  onClick={() => void startGeneration("module")}
                >
                  {generating ? (
                    <Loader2 className="pw-spin" size={15} />
                  ) : (
                    <Sparkles size={15} />
                  )}{" "}
                  生成当前模块候选
                </button>
              </>
            ) : (
              <>
                <button
                  className="pw-button pw-primary pw-wide"
                  onClick={() => setView("canvas")}
                >
                  <SquarePen size={15} /> 打开矢量画板
                </button>
                <button
                  className="pw-button pw-wide"
                  onClick={() => setView("edit")}
                >
                  {candidates.length
                    ? `查看 ${candidates.length} 个图表候选`
                    : "编辑图注与查看候选"}
                </button>
              </>
            )}
            <div className="pw-dependencies">
              <span className="pw-eyebrow">上下文</span>
              <p>
                {moduleDependencies[selected]
                  .map((id) => moduleLabels[id])
                  .join(" · ") || "研究材料"}
              </p>
            </div>
            {projectRun && run && (
              <div className="pw-run">
                <header>
                  <strong>
                    {runStatusLabel(run)}
                  </strong>
                  {generating && (
                    <button
                      aria-label="取消生成"
                      onClick={() =>
                        void action(async () => {
                          await api(`/api/paper-runs/${run.id}/cancel`, {});
                        })
                      }
                    >
                      <StopCircle size={16} />
                    </button>
                  )}
                </header>
                <div>
                  {run.events.slice(-10).map((event, i) => (
                    <p key={i}>
                      <span>{new Date(event.time).toLocaleTimeString()}</span>
                      {event.message}
                    </p>
                  ))}
                </div>
                {run.error && <p className="pw-run-error">{runFailureMessage(run.error)}</p>}
                {run.moduleFailures?.map(failure => <p key={failure.moduleId} className="pw-run-error">
                  {moduleLabels[failure.moduleId]}：{failure.message}
                </p>)}
                {run.review && <details className="pw-review-results">
                  <summary>整稿审查 · {run.review.rounds} 轮 · {run.review.issues.length} 项记录</summary>
                  <p>{run.review.summary}</p>
                  {run.review.issues.map((issue,i)=><p key={i}><strong>{moduleLabels[issue.moduleId]}</strong><br/>{issue.message}</p>)}
                </details>}
                {run.mode === "draft" &&
                  ["partial", "error", "cancelled", "interrupted"].includes(
                    run.status,
                  ) && (
                    <button
                      className="pw-button pw-wide"
                      disabled={busy || dirty || !status?.configured}
                      onClick={() => void startGeneration("draft", run.id)}
                    >
                      {run.status === 'partial' ? '重试未完成模块' : '从已保存的候选继续'}
                    </button>
                  )}
              </div>
            )}
            {!!status?.connectivity && <details className="pw-api-results">
              <summary>API 测试结果</summary>
              {status.connectivity.records.map(record => <p key={record.model}><code>{record.model}</code><br />{record.ok ? '可用' : `HTTP ${record.status ?? '—'} · ${record.error}`}</p>)}
            </details>}
          </aside>
        </main>
      )}

      {sourceMode && (
        <div className="pw-overlay">
          <section
            className="pw-modal pw-source-modal"
            role="dialog"
            aria-label="研究材料设置"
          >
            <header>
              <div>
                <h2>
                  {sourceMode === "new" ? "新建论文" : "研究材料"}
                </h2>
              </div>
              <button
                aria-label="关闭材料设置"
                onClick={() => setSourceMode(undefined)}
              >
                <X size={22} />
              </button>
            </header>
            <div className="pw-modal-body">
              <label>项目名称</label>
              <input
                aria-label="项目名称"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="你的研究主题"
              />
              <PaperInputs template={form.template} materials={form.materials} ideaSpark={form.ideaSpark}
                onTemplate={files => void action(async () => {
                  const template = await readTemplateFiles(files, form.template); setForm(f => ({ ...f, template }));
                })}
                onFile={(file, role) => void action(() => importMaterial(file, role))}
                onText={(role, content) => setForm(f => ({ ...f,
                  ideaSpark: role === 'idea' ? content : f.ideaSpark,
                  materials: [...f.materials.filter(m => m.role !== role), {
                    id: f.materials.find(m => m.role === role)?.id ?? uid(),
                    name: f.materials.find(m => m.role === role)?.name ?? `${role}.md`, role, content,
                  }],
                }))}
                onRemove={role => setForm(f => role === 'template' ? { ...f, template: undefined }
                  : { ...f, ideaSpark: role === 'idea' ? '' : f.ideaSpark, materials: f.materials.filter(m => m.role !== role) })}
                onEntry={entry => setForm(f => ({ ...f, template: { ...f.template!, entry } }))}
              />
              <button
                className="pw-button"
                onClick={() =>
                  void action(async () => {
                    const [data, template] = await Promise.all([api<any>("/api/materials/example"), api<PaperTemplate>('/api/paper-template/example')]);
                    setForm((f) => ({
                      ...f,
                      title:
                        f.title || "Synthetic document-triage demo",
                      ideaSpark: data.materials.find((m: any) => /idea/i.test(m.name))?.content ?? '',
                      template,
                      materials: [
                        ...f.materials.filter(m => m.role === 'context'),
                        ...data.materials.map((m: any) => ({
                          ...m,
                          role: /experiment/i.test(m.name)
                            ? "experiment"
                            : "idea",
                        })),
                      ],
                    }));
                  })
                }
              >
                载入演示材料
              </button>
              <details className="pw-input-options"><summary>更多设置</summary>
              <label>主稿语言<select aria-label="主稿语言" value={form.language} onChange={e => setForm({ ...form, language: e.target.value as 'en' | 'zh' })}>
                <option value="en">English</option><option value="zh">中文</option>
              </select></label>
              <label>写作要求</label>
              <textarea
                aria-label="写作规范"
                rows={3}
                value={form.guidelines}
                onChange={(e) =>
                  setForm({ ...form, guidelines: e.target.value })
                }
              />
              </details>
            </div>
            <footer>
              <button
                className="pw-button"
                onClick={() => setSourceMode(undefined)}
              >
                取消
              </button>
              <button
                className="pw-button pw-primary"
                disabled={
                  busy || (!form.ideaSpark.trim() && !form.materials.length)
                }
                onClick={() => void submitSources()}
              >
                {busy ? (
                  <Loader2 size={15} className="pw-spin" />
                ) : (
                  <Check size={15} />
                )}{" "}
                保存研究项目
              </button>
            </footer>
          </section>
        </div>
      )}
      {figureSubmission && (
        <div className="pw-overlay">
          <section className="pw-modal" role="dialog" aria-label="提交图表候选">
            <header>
              <h2>提交图表到论文</h2>
              <button
                onClick={() => setFigureSubmission(undefined)}
                aria-label="关闭图表提交"
              >
                <X size={20} />
              </button>
            </header>
            <div className="pw-modal-body">
              <label>图注</label>
              <textarea
                aria-label="图表图注"
                rows={5}
                value={figureSubmission.caption}
                onChange={(e) =>
                  setFigureSubmission({
                    ...figureSubmission,
                    caption: e.target.value,
                  })
                }
              />
            </div>
            <footer>
              <button
                className="pw-button"
                onClick={() => setFigureSubmission(undefined)}
              >
                取消
              </button>
              <button
                className="pw-button pw-primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const p = projectRef.current!;
                    setProject(
                      await api<PaperProject>(
                        `/api/papers/${p.id}/figure-candidates`,
                        {
                          ...figureSubmission,
                          expectedRevision: figureBase.current?.revision,
                          expectedSourceRevision:
                            figureBase.current?.sourceRevision,
                          expectedDependencyVersions:
                            figureBase.current?.dependencies,
                        },
                      ),
                    );
                    setFigureSubmission(undefined);
                    setView("edit");
                    setMessage("图表候选已提交。点击接受后更新主稿。");
                  })
                }
              >
                提交候选 <ArrowRight size={15} />
              </button>
            </footer>
          </section>
        </div>
      )}
      {citationForm && (
        <div className="pw-overlay">
          <section className="pw-modal" role="dialog" aria-label="手动登记文献">
            <header>
              <h2>登记真实文献</h2>
              <button
                onClick={() => setCitationForm(undefined)}
                aria-label="关闭文献登记"
              >
                <X size={20} />
              </button>
            </header>
            <div className="pw-modal-body">
              {[
                ["title", "文献标题"],
                ["authors", "作者（逗号分隔）"],
                ["year", "年份"],
                ["url", "原文 URL"],
                ["abstract", "摘要 / 证据笔记"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    aria-label={label}
                    value={citationForm[key as keyof typeof citationForm]}
                    onChange={(e) =>
                      setCitationForm({
                        ...citationForm,
                        [key]: e.target.value,
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <footer>
              <button
                className="pw-button pw-primary"
                disabled={busy || !citationForm.title.trim()}
                onClick={() =>
                  void action(async () => {
                    setProject(
                      await api<PaperProject>(
                        `/api/papers/${project!.id}/citations`,
                        {
                          ...citationForm,
                          authors: citationForm.authors
                            .split(/[,，]/)
                            .map((a) => a.trim())
                            .filter(Boolean),
                        },
                      ),
                    );
                    setCitationForm(undefined);
                  })
                }
              >
                保存文献
              </button>
            </footer>
          </section>
        </div>
      )}
      {candidateDraft&&<div className="pw-overlay"><section className="pw-modal pw-source-modal" role="dialog" aria-label="编辑章节候选">
        <header><h2>编辑候选</h2><button aria-label="关闭候选编辑" onClick={()=>setCandidateDraft(undefined)}><X size={20}/></button></header>
        <div className="pw-modal-body"><textarea aria-label="候选内容" className="pw-editor" value={candidateDraft.content} onChange={e=>setCandidateDraft({...candidateDraft,content:e.target.value})}/></div>
        <footer><button className="pw-button pw-primary" disabled={busy||!candidateDraft.content.trim()} onClick={()=>void action(async()=>{
          setProject(await api<PaperProject>(`/api/papers/${project!.id}/candidates/${candidateDraft.id}/edit`,{content:candidateDraft.content}));
          setCandidateDraft(undefined);setCandidateId('');
        })}>保存候选</button></footer>
      </section></div>}
      {helpOpen && (
        <div className="pw-overlay">
          <section
            className="pw-modal"
            role="dialog"
            aria-label="工作台使用帮助"
          >
            <header>
              <h2>如何使用这套工作台</h2>
              <button aria-label="关闭帮助" onClick={() => setHelpOpen(false)}>
                <X size={20} />
              </button>
            </header>
            <div className="pw-modal-body pw-help">
              <ol>
                <li>
                  新建研究，上传论文模板、Idea 和 Experiment。也可以先载入示例。
                </li>
                <li>
                  生成整篇候选，或选择一个模块、方法与模型，只生成该模块。
                </li>
                <li>
                  查看差异和检查结果。确认“接受”后，新内容才会进入全文预览。
                </li>
                <li>
                  手动修改章节并保存。锁定重要章节；更新其他模块不会自动改写它。
                </li>
                <li>绘图进入矢量画板，编辑后“提交到论文”，再接受图表候选。</li>
                <li>
                  导出项目 JSON
                  可交给合作伙伴；导入时创建独立副本。当前不是多人实时协同编辑。
                </li>
              </ol>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

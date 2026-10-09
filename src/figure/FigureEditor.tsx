import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Layers,
  Loader2,
  Lock,
  Unlock,
  PanelLeftClose,
  PanelRight,
  Plus,
  Redo2,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
  Workflow,
  AlertCircle,
  StopCircle,
} from "lucide-react";
import type {
  AgentConfig,
  FigureScene,
  Material,
  Primitive,
  Reference,
  RunRecord,
  WorkerRole,
  WorkerMethod,
  PlanningCheckpoint,
} from "../../shared/types";
import { allPrimitives, patchPrimitive, sceneSvg } from "../../shared/svg";
import { objectIsLocked } from "../../shared/locks";
import { CanvasEditor } from "./CanvasEditor";
import { GenerationDialog } from "./GenerationDialog";
import { ApiSettingsButton } from '../settings/ApiSettings';
import { useApiSettingsUpdates } from '../settings/api-settings-events';
import { ConnectionSelect, useConnectionSettings } from '../settings/ConnectionSelect';
import "./figure.css";

const embeddedPaperId = new URLSearchParams(location.search).get("paper");
const embedded = Boolean(embeddedPaperId) && window.parent !== window;
const storageKey = embeddedPaperId
  ? `paper-atelier-embedded-${embeddedPaperId}`
  : "paper-atelier-v1";

const uid = () => crypto.randomUUID();
const apiNotConfigured = "API 未配置。请打开“API 设置”添加连接。";
const roles: Record<WorkerRole, string> = {
  illustration: "插画与机制",
  structure: "结构与流程",
  plot: "统计与示意图",
};
const methodNames: Record<WorkerMethod, string> = {
  "vector-agent": "自由矢量设计",
  "asset-assisted": "矢量素材 + 自由设计",
  "diagram-agent": "结构化图解",
};
const quality: AgentConfig = {
  pipeline: "visual-reconstruction",
  imageModel: "google/gemini-3-pro-image",
  fidelityRounds: 4,
  planner: "google/gemini-3.1-pro-preview",
  director: "google/gemini-3.1-pro-preview",
  worker: "google/gemini-3.1-pro-preview",
  assembler: "google/gemini-3.1-pro-preview",
  critic: "google/gemini-3.1-pro-preview",
  methods: {
    illustration: "asset-assisted",
    structure: "vector-agent",
    plot: "vector-agent",
  },
  reviewRounds: 2,
};
const modelRoles = [
  ["planner", "科学内容分析"],
  ["director", "视觉设计总监"],
  ["worker", "模块设计师"],
  ["assembler", "整图组装"],
  ["critic", "视觉与科学审查"],
] as const;
type Selection = {
  moduleId?: string;
  elementId?: string;
  connectorId?: string;
  regionId?: string;
  kind?: string;
};
const initialIntent =
  "绘制论文的方法总览图：解释完整机制、关键模块内部细节及其关系。忠实于材料，不虚构实验曲线或性能结论。";
function readSaved() {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let message = r.statusText;
    try {
      message = (await r.json()).error ?? message;
    } catch {}
    throw Error(message);
  }
  return r.json();
}
const jsonPost = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
function saveFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function removeElement(items: Primitive[], id: string): Primitive[] {
  return items
    .filter((e) => e.id !== id)
    .map((e) => ({
      ...e,
      children: e.children ? removeElement(e.children, id) : undefined,
    }));
}

export default function App() {
  const connectionSettings=useConnectionSettings();
  const saved = useRef(readSaved()).current;
  const [scene, setScene] = useState<FigureScene | undefined>(saved.scene),
    [materials, setMaterials] = useState<Material[]>(saved.materials ?? []),
    [intent, setIntent] = useState(saved.intent ?? initialIntent),
    [figureType, setFigureType] = useState("method-overview");
  const [references, setReferences] = useState<Reference[]>([]),
    [chosenRefs, setChosenRefs] = useState<string[]>(
      saved.chosenRefs ?? ["multi-panel", "nested-memory", "trajectory"],
    ),
    [config, setConfig] = useState<AgentConfig>({...quality,...saved.config});
  const [tab, setTab] = useState<"materials" | "layers">(
      saved.scene ? "layers" : "materials",
    ),
    [generationOpen, setGenerationOpen] = useState(false),
    [generationTab, setGenerationTab] = useState<"figure" | "models">("figure"),
    // Only explicit pane controls change visibility; selection updates its content.
    [inspectorOpen, setInspectorOpen] = useState(true),
    [selection, setSelection] = useState<Selection>({}),
    [focus, setFocus] = useState(""),
    [run, setRun] = useState<RunRecord>(),
    [runId, setRunId] = useState(saved.runId ?? ""),
    [error, setError] = useState(""),
    [configured, setConfigured] = useState(false),
    [traceOpen, setTraceOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [showPlan, setShowPlan] = useState(false),
    [showBlueprint, setShowBlueprint] = useState(false),
    [localInstruction, setLocalInstruction] = useState(""),
    [models, setModels] = useState<
      { id: string; name: string; vision: boolean }[]
    >([]),
    [leftCollapsed, setLeftCollapsed] = useState(false),
    [toast, setToast] = useState("");
  const undoStack = useRef<FigureScene[]>([]),
    redoStack = useRef<FigureScene[]>([]),
    [historyVersion, setHistoryVersion] = useState(0),
    liveScene = useRef(scene),
    upload = useRef<HTMLInputElement>(null),
    importProject = useRef<HTMLInputElement>(null),
    referenceUpload = useRef<HTMLInputElement>(null),
    runStart = useRef<FigureScene | undefined>(undefined);
  liveScene.current = scene;
  const liveRunId = useRef(runId);
  liveRunId.current = runId;
  const busy = !!runId;
  const roleConnection=(key:typeof modelRoles[number][0])=>connectionSettings?.connections.find(c=>c.id===(config.connections?.[key]||connectionSettings.defaultConnectionId));
  const pictureConnection=connectionSettings?.connections.find(c=>c.id===(config.connections?.image||connectionSettings.defaultImageConnectionId));
  const allTextOpenRouter=modelRoles.every(([key])=>roleConnection(key)?.protocol==='openrouter');
  const applyConnectionModels=(qualityPreset=false)=>setConfig(previous=>{
    const next={...(qualityPreset?quality:previous),connections:previous.connections};
    for(const [key] of modelRoles){const connection=roleConnection(key);next[key]=qualityPreset&&connection?.protocol==='openrouter'?quality[key]:connection?.textModel||'';}
    next.imageModel=qualityPreset&&pictureConnection?.protocol==='openrouter'?quality.imageModel:pictureConnection?.imageModel||'';
    return next;
  });
  const figureApiConfigured=configured||Boolean(config.connections?.planner&&connectionSettings?.connections.find(c=>c.id===config.connections?.planner)?.configured);
  useApiSettingsUpdates(settings => {
    setConfigured(settings.configured);
    if (settings.configured) setError(previous => previous === apiNotConfigured ? "" : previous);
  });
  const selectedModule = scene?.modules.find(
    (m) => m.id === selection.moduleId,
  );
  const rawElement =
    scene && selection.elementId
      ? allPrimitives(selectedModule?.elements ?? scene.annotations).find(
          (e) => e.id === selection.elementId,
        )
      : undefined;
  const selectedElement = rawElement
    ? {
        ...rawElement,
        locked:
          rawElement.locked ||
          objectIsLocked(
            selectedModule?.elements ?? scene!.annotations,
            rawElement.id,
          ),
      }
    : undefined;
  const selectedConnector = scene?.connectors.find(
      (e) => e.id === selection.connectorId,
    ),
    selectedRegion = scene?.regions.find((r) => r.id === selection.regionId);
  useEffect(() => {
    void api<any>("/api/status")
      .then((s) => {
        setConfigured(s.configured);
        setReferences(s.references);
        if (!s.configured)
          setError(
            apiNotConfigured,
          );
      })
      .catch((e) => setError(String(e)));
    if (!saved.scene && !embeddedPaperId)
      void api<any>("/api/projects")
        .then(async (r) => {
          if (r.projects?.length) {
            const s = await api<FigureScene>(
              "/api/projects/" + r.projects[0].id,
            );
            if (!liveScene.current) {
              setScene(s);
              setTab("layers");
              setMaterials(s.materials ?? []);
              setToast("已打开最近生成的可编辑图。");
            }
          }
        })
        .catch(() => {});
  }, []);
  useEffect(()=>{
    if(!connectionSettings)return;
    const controller=new AbortController();setModels([]);
    void api<any>("/api/models?connection="+encodeURIComponent(connectionSettings.defaultConnectionId),{signal:controller.signal})
      .then(r=>{if(!controller.signal.aborted)setModels(r.models);}).catch(()=>{});
    return()=>controller.abort();
  },[connectionSettings?.defaultConnectionId,connectionSettings?.connections.find(c=>c.id===connectionSettings.defaultConnectionId)?.revision]);
  useEffect(() => {
    if (!embedded) return;
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== window.parent ||
        event.data?.type !== "paper-workbench:load-figure"
      )
        return;
      if (liveRunId.current) {
        window.parent.postMessage(
          {
            type: "paper-workbench:figure-error",
            message: "画板正在生成，请先完成或取消当前任务。",
          },
          location.origin,
        );
        return;
      }
      const value = event.data.scene as FigureScene | null;
      if (value && value.schema !== "paper-atelier/1") return;
      setScene(value ?? undefined);
      setTab(value ? "layers" : "materials");
      liveScene.current = value ?? undefined;
      setMaterials(event.data.materials ?? []);
      setIntent(event.data.intent ?? initialIntent);
      setFigureType(value?.figureType ?? "method-overview");
      undoStack.current = [];
      redoStack.current = [];
      setHistoryVersion((v) => v + 1);
      setSelection({});
      setFocus("");
      if (value?.agentConfig) setConfig({...quality,...value.agentConfig});
      setToast(
        value
          ? "已打开论文中的矢量对象。编辑后提交候选。"
          : "论文材料已载入画板，请选择方法并生成图。",
      );
    };
    window.addEventListener("message", receive);
    window.parent.postMessage(
      { type: "paper-workbench:figure-ready" },
      location.origin,
    );
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            scene,
            materials,
            intent,
            config,
            chosenRefs,
            runId,
          }),
        );
      } catch {
        setToast("本地存储空间不足，请导出项目 JSON 保存。");
      }
    }, 800);
    return () => clearTimeout(t);
  }, [scene, materials, intent, config, chosenRefs, runId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!runId) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<RunRecord>("/api/runs/" + runId);
        if (stopped) return;
        setRun(r);
        if (r.scene) {
          setScene(r.scene);
          setTab("layers");
        }
        if (r.status === "running") {
          timer = setTimeout(poll, 1500);
        } else {
          setRunId("");
          if (r.error) setError(r.error);
          if (r.status === "complete") {
            if (runStart.current) undoStack.current.push(runStart.current);
            redoStack.current = [];
            setHistoryVersion((v) => v + 1);
            setToast(
              r.scene?.review?.status === "needs-revision"
                ? "图已生成，但审查仍有问题；请查看审查结果。"
                : "可编辑图已生成，双击模块开始编辑。",
            );
          }
        }
      } catch (e) {
        if (!stopped) {
          setError("无法读取任务状态：" + String(e));
          setRunId("");
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);
  const apply = (next: FigureScene, preserveReview = false) => {
    if (busy) return;
    if (liveScene.current)
      undoStack.current.push(structuredClone(liveScene.current));
    undoStack.current = undoStack.current.slice(-40);
    redoStack.current = [];
    setScene(preserveReview ? next : { ...next, review: undefined });
    setHistoryVersion((v) => v + 1);
  };
  const undo = () => {
    if (!scene || busy) return;
    const previous = undoStack.current.pop();
    if (previous) {
      redoStack.current.push(scene);
      setScene(previous);
      setHistoryVersion((v) => v + 1);
    }
  };
  const redo = () => {
    if (!scene || busy) return;
    const next = redoStack.current.pop();
    if (next) {
      undoStack.current.push(scene);
      setScene(next);
      setHistoryVersion((v) => v + 1);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.isContentEditable || target.closest("dialog")
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [scene, busy, historyVersion]);
  const addMaterials = async (files: FileList | null) => {
    if (!files) return;
    const list = await Promise.all(
      Array.from(files)
        .filter((f) => /\.(md|txt|json|csv)$/i.test(f.name))
        .map(async (f) => ({
          id: uid(),
          name: f.name,
          content: await f.text(),
        })),
    );
    setMaterials((prev) => [
      ...prev.filter((m) => !list.some((n) => n.name === m.name)),
      ...list,
    ]);
    if (!list.length) setError("请选择 Markdown、TXT、JSON 或 CSV 文件。");
  };
  const loadExample = async () => {
    try {
      const r = await api<{ materials: Material[] }>("/api/materials/example");
      setMaterials(r.materials);
        setToast("已载入合成演示材料，不包含真实实验结果。");
    } catch (e) {
      setError(String(e));
    }
  };
  const start = async (
    local = false,
    resume = false,
    resumePlanning = false,
  ) => {
    setError("");
    if (!materials.length) {
      setError("先导入研究材料，或载入工作区的两个 Markdown 文件。");
      setTab("materials");
      return;
    }
    if (local && (!scene || !selectedModule || selectedModule.locked)) {
      setError("请选择一个未锁定的模块。");
      return;
    }
    try {
      runStart.current = scene ? structuredClone(scene) : undefined;
      const localConfig = structuredClone(config);
      if (local && selectedModule)
        localConfig.methods[selectedModule.role] = selectedModule.method;
      const r = await api<{ id: string }>(
        "/api/runs",
        jsonPost({
          materials,
          references: references.filter((r) => chosenRefs.includes(r.id)),
          intent,
          figureType,
          config: localConfig,
          ...(local
            ? {
                scene,
                moduleId: selectedModule!.id,
                instruction: localInstruction,
              }
            : {}),
          ...(resume ? { resumeScene: scene, resumeDrafts: run?.drafts } : {}),
          ...(resumePlanning && run?.planningContext && run.drafts?.grounder
            ? {
                resumePlanning: {
                  ...run.planningContext,
                  semanticPlan: run.drafts.grounder,
                  designDraft: run.drafts.director,
                } as PlanningCheckpoint,
              }
            : {}),
        }),
      );
      setRun({ id: r.id, status: "running", events: [] });
      setRunId(r.id);
      setGenerationOpen(false);
      setTraceOpen(true);
      setSelection(local ? selection : {});
      setFocus("");
    } catch (e) {
      setError(String(e));
    }
  };
  const changeModule = (patch: Record<string, unknown>) => {
    if (
      !scene ||
      !selectedModule ||
      (selectedModule.locked && !("locked" in patch))
    )
      return;
    const next = structuredClone(scene);
    Object.assign(
      next.modules.find((m) => m.id === selectedModule.id)!,
      patch,
    );
    apply(next);
  };
  const changeElement = (patch: Partial<Primitive>) => {
    if (
      !scene ||
      !selectedElement ||
      selectedModule?.locked ||
      (selectedElement.locked && !("locked" in patch))
    )
      return;
    const next = structuredClone(scene);
    if (selectedModule) {
      const m = next.modules.find((m) => m.id === selectedModule.id)!;
      m.elements = patchPrimitive(m.elements, selectedElement.id, patch);
    } else
      next.annotations = patchPrimitive(
        next.annotations,
        selectedElement.id,
        patch,
      );
    apply(next);
  };
  const addObject = (type: "text" | "rect") => {
    if (!scene || busy) return;
    const next = structuredClone(scene),
      m = next.modules.find((m) => m.id === focus);
    if (m?.locked) return;
    const e: Primitive = {
      id: uid(),
      type,
      x: m ? 30 : scene.width * 0.4,
      y: m ? 30 : scene.height * 0.4,
      ...(type === "text"
        ? { text: "双击编辑文字", fontSize: 26, fill: scene.style.ink }
        : {
            width: 130,
            height: 70,
            fill: "#eef3fa",
            stroke: scene.style.accent,
            strokeWidth: 2,
            radius: 8,
          }),
    };
    if (m) m.elements.push(e);
    else next.annotations.push(e);
    apply(next);
    setSelection({ moduleId: m?.id, elementId: e.id, kind: "primitive" });
  };
  const deleteObject = () => {
    if (
      !scene ||
      !selectedElement ||
      selectedElement.locked ||
      selectedModule?.locked
    )
      return;
    const next = structuredClone(scene);
    if (selectedModule) {
      const m = next.modules.find((m) => m.id === selectedModule.id)!;
      m.elements = removeElement(m.elements, selectedElement.id);
    } else
      next.annotations = removeElement(next.annotations, selectedElement.id);
    apply(next);
    setSelection({ moduleId: selectedModule?.id });
  };
  const exportFile = async (format: string) => {
    if (!scene) return;
    setExportOpen(false);
    const name =
      scene.title.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 70) ||
      "research-figure";
    if (format === "svg")
      saveFile(
        name + ".svg",
        new Blob([sceneSvg(scene)], { type: "image/svg+xml" }),
      );
    if (format === "json")
      saveFile(
        name + ".json",
        new Blob([JSON.stringify(scene, null, 2)], {
          type: "application/json",
        }),
      );
    if (format === "png") {
      try {
        const r = await fetch("/api/render", jsonPost(scene));
        if (!r.ok) throw Error(await r.text());
        saveFile(name + ".png", await r.blob());
      } catch (e) {
        setError(String(e));
      }
    }
  };
  const restore = async (file?: File) => {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text()) as FigureScene;
      if (
        value.schema !== "paper-atelier/1" ||
        !Array.isArray(value.modules) ||
        !value.style
      )
        throw Error("不是 Paper Studio 矢量项目文件");
      if (scene) apply(value, true);
      else setScene(value);
      setTab("layers");
      setMaterials(value.materials ?? materials);
      if (value.agentConfig) setConfig({...quality,...value.agentConfig});
      if (value.intent) setIntent(value.intent);
      if (value.figureType) setFigureType(value.figureType);
      if (value.references?.length) {
        setReferences((refs) => [
          ...refs.filter((r) => !value.references!.some((v) => v.id === r.id)),
          ...value.references!,
        ]);
        setChosenRefs(value.references.map((r) => r.id).slice(0, 3));
      }
      setSelection({});
      setFocus("");
      setToast("已打开可编辑项目。");
    } catch (e) {
      setError(String(e));
    }
  };
  const addReference = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 3)) {
      if (!f.type.startsWith("image/") || f.size > 4_000_000) {
        setError("参考图请选择 4 MB 以内的图片。");
        continue;
      }
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(f);
      });
      const ref = {
        id: uid(),
        name: f.name,
        url: dataUrl,
        dataUrl,
        description:
          "User-provided visual composition reference. Style only; never import scientific claims from this image.",
      };
      setReferences((r) => [...r, ref]);
      setChosenRefs((ids) => [...ids, ref.id].slice(-3));
    }
  };
  const roleStage = (stage: string) =>
    stage.startsWith("worker:")
      ? "模块设计"
      : ({
          grounder: "科学内容分析",
          director: "视觉总方案",
          assembler: "整图组装",
          critic: "视觉审查",
          export: "交付",
        }[stage] ?? stage);
  const layerPick = (moduleId: string, elementId?: string) => {
    setSelection({
      moduleId,
      elementId,
      kind: elementId ? "primitive" : "module",
    });
    setFocus(elementId ? moduleId : "");
  };
  // Some scenes intentionally omit module titles to avoid duplicating region headings.
  // Use those headings for editor navigation without changing the exported figure.
  const moduleLabel = (module: FigureScene["modules"][number]) =>
    module.title || scene?.regions
      .filter((region) => module.x >= region.x && module.y >= region.y &&
        module.x + module.width <= region.x + region.width &&
        module.y + module.height <= region.y + region.height)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0]?.title ||
    module.labels[0] || module.id;
  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".export-wrap")) setExportOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setExportOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", key); };
  }, [exportOpen]);
  const materialPanel = <>
                <div className="section-heading">
                  <h3>研究材料</h3>
                  <span>{materials.length} 个文件</span>
                </div>
                <button
                  className="upload-zone"
                  onClick={() => upload.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void addMaterials(e.dataTransfer.files);
                  }}
                  disabled={busy}
                >
                  <Upload size={19} />
                  <strong>导入研究材料</strong>
                  <span>拖入 .md / .txt / .json / .csv</span>
                </button>
                <button
                  className="example-button"
                  onClick={() => void loadExample()}
                  disabled={busy}
                >
                  <FolderOpen size={14} /> 载入示例材料
                </button>
                <div className="files">
                  {materials.map((m) => (
                    <div className="file-item" key={m.id}>
                      <FileText size={16} />
                      <div>
                        <strong>{m.name}</strong>
                        <span>{m.content.length.toLocaleString()} 字符</span>
                      </div>
                      <button
                        title="移除材料"
                        disabled={busy}
                        onClick={() =>
                          setMaterials((v) => v.filter((x) => x.id !== m.id))
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>

  </>;
  const figureSettings = <>
                <div className="section-heading">
                  <h3>图形</h3>
                </div>
                <label className="field">
                  图类型
                  <select
                    aria-label="图类型"
                    value={figureType}
                    onChange={(e) => setFigureType(e.target.value)}
                    disabled={busy}
                  >
                    {!["method-overview", "architecture", "training-inference", "mechanism", "comparison"].includes(figureType) &&
                      <option value={figureType}>{figureType}</option>}
                    <option value="method-overview">方法总览图</option>
                    <option value="architecture">系统 / 模型架构</option>
                    <option value="training-inference">训练与推理流程</option>
                    <option value="mechanism">核心机制详解</option>
                    <option value="comparison">方法对比图</option>
                  </select>
                </label>
                <label className="field">
                  绘图要求
                  <textarea
                    rows={5}
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <div className="section-heading">
                  <h3>参考图</h3>
                  <button
                    title="添加参考图"
                    onClick={() => referenceUpload.current?.click()}
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <p className="hint">
                  最多选择 3 张参考图。
                </p>
                <div className="reference-list">
                  {references.map((r) => (
                    <button
                      key={r.id}
                      className={
                        "reference " +
                        (chosenRefs.includes(r.id) ? "chosen" : "")
                      }
                      onClick={() =>
                        setChosenRefs((ids) =>
                          ids.includes(r.id)
                            ? ids.filter((id) => id !== r.id)
                            : [...ids, r.id].slice(-3),
                        )
                      }
                    >
                      <img src={r.dataUrl ?? r.url} alt={r.name} />
                      <span>{r.name}</span>
                      <i>{chosenRefs.includes(r.id) && <Check size={12} />}</i>
                    </button>
                  ))}
                </div>

  </>;
  const modelSettings = <>
                <label className="field">
                  生成流程
                  <select aria-label="生成流程" value={config.pipeline??"visual-reconstruction"} disabled={busy}
                    onChange={e=>setConfig(v=>({...v,pipeline:e.target.value as AgentConfig["pipeline"]}))}>
                    <option value="visual-reconstruction">AI 视觉方案 → 保真矢量重建</option>
                    <option value="vector-design">自由矢量设计（原流程）</option>
                  </select>
                </label>
                {config.pipeline==="visual-reconstruction" && <>
                  <label className="field">图片 API 连接
                    <ConnectionSelect settings={connectionSettings} value={config.connections?.image} kind="image" label="图片设计 API 连接" disabled={busy}
                      onChange={id=>setConfig(v=>({...v,connections:{...v.connections,image:id},imageModel:connectionSettings?.connections.find(c=>c.id===(id||connectionSettings.defaultImageConnectionId))?.imageModel||''}))}/>
                  </label>
                  <label className="field">图片设计模型
                    <input aria-label="图片设计模型" value={config.imageModel??"google/gemini-3-pro-image"} disabled={busy}
                      onChange={e=>setConfig(v=>({...v,imageModel:e.target.value}))}/>
                  </label>
                  <label className="field">视觉对照修订轮次
                    <select aria-label="视觉对照修订轮次" value={config.fidelityRounds??4} disabled={busy}
                      onChange={e=>setConfig(v=>({...v,fidelityRounds:Number(e.target.value)}))}>
                      {[1,2,4,6,8].map(n=><option value={n} key={n}>{n} 次</option>)}
                    </select>
                  </label>
                </>}
                <div className="section-heading">
                  <h3>生成配置</h3>
                </div>
                <div className="preset-row">
                  <button onClick={() => applyConnectionModels(true)} disabled={busy||!connectionSettings}>
                    质量优先
                  </button>
                  <button onClick={()=>applyConnectionModels()} disabled={busy||!connectionSettings}>使用连接默认模型</button>
                  <button
                    onClick={() =>
                      setConfig({
                        ...config,
                        planner: "google/gemma-4-31b-it",
                        director: "google/gemma-4-31b-it",
                        worker: "google/gemma-4-31b-it",
                        assembler: "google/gemma-4-31b-it",
                        critic: "google/gemma-4-31b-it",
                      })
                    }
                    disabled={busy||!allTextOpenRouter}
                    title="此模型预设仅适用于 OpenRouter 文本连接"
                  >
                    Gemma 经济版
                  </button>
                </div>
                <div className="pipeline-mini">
                  {config.pipeline==="visual-reconstruction" ? <>蓝图 <ArrowRight size={11} /> 拆解 <ArrowRight size={11} /> 元素 <ArrowRight size={11} /> 组装 <ArrowRight size={11} /> 对照</> : <>分析 <ArrowRight size={11} /> 设计 <ArrowRight size={11} /> 并行模块 <ArrowRight size={11} /> 组装 <ArrowRight size={11} /> 审查</>}
                </div>
                {modelRoles.map(([key, label], i) => (
                  <label className="field model-field" key={key}>
                    <span>
                      <b>0{i + 1}</b>
                      {label}
                      {(key === "director" || key === "critic") && (
                        <em>需视觉模型</em>
                      )}
                    </span>
                    <ConnectionSelect settings={connectionSettings} value={config.connections?.[key]} label={label+' API 连接'} disabled={busy}
                      onChange={id=>setConfig(v=>({...v,connections:{...v.connections,[key]:id},[key]:connectionSettings?.connections.find(c=>c.id===(id||connectionSettings.defaultConnectionId))?.textModel||''}))}/>
                    <input
                      aria-label={label+'模型 ID'}
                      list={'model-list-'+key}
                      value={config[key]}
                      disabled={busy}
                      onChange={(e) =>
                        setConfig((v) => ({ ...v, [key]: e.target.value }))
                      }
                    />
                    <datalist id={'model-list-'+key}>
                      {roleConnection(key)?.textModel&&<option value={roleConnection(key)?.textModel}/>}
                      {(config.connections?.[key]||connectionSettings?.defaultConnectionId)===connectionSettings?.defaultConnectionId&&models.map(m=><option key={m.id} value={m.id}>{m.name}{m.vision?' · Vision':''}</option>)}
                    </datalist>
                  </label>
                ))}
                {config.pipeline!=="visual-reconstruction" && <>
                <div className="section-heading">
                  <h3>模块方法</h3>
                </div>
                {(Object.keys(roles) as WorkerRole[]).map((role) => (
                  <label className="field" key={role}>
                    {roles[role]}
                    <select
                      value={config.methods[role]}
                      disabled={busy}
                      onChange={(e) =>
                        setConfig((v) => ({
                          ...v,
                          methods: {
                            ...v.methods,
                            [role]: e.target.value as WorkerMethod,
                          },
                        }))
                      }
                    >
                      {Object.entries(methodNames).map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label className="field">
                  审查与局部修订
                  <select
                    value={config.reviewRounds}
                    disabled={busy}
                    onChange={(e) =>
                      setConfig((v) => ({
                        ...v,
                        reviewRounds: Number(e.target.value),
                      }))
                    }
                  >
                    <option value={0}>不运行视觉审查</option>
                    <option value={1}>检查一次，不自动修订</option>
                    <option value={2}>检查 → 局部修订 → 再检查</option>
                  </select>
                </label>
                </>}

  </>;
  return (
    <div className={"app-shell " + (embedded ? "embedded" : "")}>
      {!embedded && <header className="topbar">
        <div className="brand"><Workflow size={19} /><strong>画板</strong></div>
        <a className="workbench-link" href="/">论文工作台</a>
      </header>}
      <input
        hidden
        type="file"
        ref={importProject}
        accept=".json"
        onChange={(e) => void restore(e.target.files?.[0])}
      />
      <input hidden multiple type="file" ref={upload} accept=".md,.txt,.json,.csv" onChange={(e) => { void addMaterials(e.target.files); e.target.value = ""; }} />
      <input hidden multiple type="file" ref={referenceUpload} accept="image/*" onChange={(e) => { void addReference(e.target.files); e.target.value = ""; }} />
          <div className="editor-toolbar">
            <div className="editor-tools">
              <button
                title={leftCollapsed ? "展开侧栏" : "收起侧栏"}
                aria-label={leftCollapsed ? "展开侧栏" : "收起侧栏"}
                aria-expanded={!leftCollapsed}
                onClick={() => setLeftCollapsed(!leftCollapsed)}
              >
                {leftCollapsed ? (
                  <ChevronRight size={16} />
                ) : (
                  <PanelLeftClose size={16} />
                )}
              </button>
              <i />
              <button
                title="撤销 Ctrl+Z"
                onClick={undo}
                disabled={busy || !undoStack.current.length}
              >
                <Undo2 size={16} />
              </button>
              <button
                title="重做 Ctrl+Shift+Z"
                onClick={redo}
                disabled={busy || !redoStack.current.length}
              >
                <Redo2 size={16} />
              </button>
              <i />
              <button
                title="添加可编辑文字"
                disabled={!scene || busy}
                onClick={() => addObject("text")}
              >
                <Type size={17} />
              </button>
              <button
                title="添加形状"
                disabled={!scene || busy}
                onClick={() => addObject("rect")}
              >
                <Square size={16} />
              </button>
            </div>
            <span className="editor-title" title={scene?.title}>{scene?.title ?? "新建图表"}</span>
            <div className="editor-actions">
              <ApiSettingsButton iconOnly />
              {run?.visualReference && <button className="text-button" aria-pressed={showBlueprint} onClick={()=>setShowBlueprint(!showBlueprint)}>
                {showBlueprint?'返回矢量图':'视觉方案'}
              </button>}
              <button title="打开项目" aria-label="打开项目" disabled={busy} onClick={() => importProject.current?.click()}>
                <FolderOpen size={16} />
              </button>
              <button className="text-button generation-trigger" aria-haspopup="dialog" onClick={() => setGenerationOpen(true)}>
                <Sparkles size={15} /><span>生成图表</span>
              </button>
              {busy && <button title="停止任务" aria-label="停止任务" className="danger" onClick={() => void api("/api/runs/" + runId + "/cancel", jsonPost({}))}><StopCircle size={16} /></button>}
              <button title="运行记录" aria-label="运行记录" aria-expanded={traceOpen} className={traceOpen ? "active" : ""} onClick={() => setTraceOpen(!traceOpen)}>
                <Workflow size={16} />
              </button>
              <button title="属性" aria-label="属性" aria-expanded={inspectorOpen} className={inspectorOpen ? "active" : ""} onClick={() => setInspectorOpen(!inspectorOpen)}>
                <PanelRight size={16} />
              </button>
              <i />
              <div className="export-wrap">
                <button className="text-button" disabled={!scene || busy} aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}>
                  <Download size={15} /><span>导出</span><ChevronDown size={12} />
                </button>
                {exportOpen && <div className="popover" role="menu">
                  <button role="menuitem" onClick={() => void exportFile("svg")}>SVG 矢量图</button>
                  <button role="menuitem" onClick={() => void exportFile("json")}>JSON 可编辑项目</button>
                  <button role="menuitem" onClick={() => void exportFile("png")}>PNG 预览图</button>
                </div>}
              </div>
              {embedded && <button className="button dark submit-figure" disabled={!scene || busy} onClick={() =>
                window.parent.postMessage({ type: "paper-workbench:figure-submit", scene: liveScene.current }, location.origin)
              }>提交到论文</button>}
            </div>
          </div>
      <main className={"workspace " + (leftCollapsed ? "collapsed " : "") + (inspectorOpen ? "" : "no-inspector")}>
        <aside className="left-panel">
          <div className="panel-tabs">
            <button className={tab === "layers" ? "active" : ""} onClick={() => setTab("layers")}><Layers size={15} />图层</button>
            <button className={tab === "materials" ? "active" : ""} onClick={() => setTab("materials")}><FileText size={15} />材料</button>
          </div>
          <div className="panel-scroll">
            {tab === "materials" && materialPanel}
            {tab === "layers" && (
              <>
                <div className="section-heading">
                  <h3>图层</h3>
                  <span>
                    {scene
                      ? allPrimitives(scene.modules.flatMap((m) => m.elements))
                          .length
                      : 0}{" "}
                    个对象
                  </span>
                </div>
                <p className="hint">
                  双击模块，编辑内部对象。
                </p>
                {!scene && (
                  <div className="empty-small">生成或打开项目后显示图层。</div>
                )}
                {scene?.modules.map((m) => (
                  <div className="layer-module" key={m.id}>
                    <button
                      data-layer-module={m.id}
                      className={
                        "layer-row " +
                        (selection.moduleId === m.id ? "selected" : "")
                      }
                      onClick={() => layerPick(m.id)}
                    >
                      <Layers size={14} />
                      <strong>{moduleLabel(m)}</strong>
                      {m.locked && <Lock size={11} />}
                      <ChevronRight size={12} />
                    </button>
                    {selection.moduleId === m.id && (
                      <div className="layer-elements">
                        {allPrimitives(m.elements)
                          .filter((e) => e.type !== "group")
                          .map((e) => (
                            <button
                              key={e.id}
                              className={
                                selection.elementId === e.id ? "selected" : ""
                              }
                              onClick={() => layerPick(m.id, e.id)}
                            >
                              {e.type === "text" ? (
                                <Type size={12} />
                              ) : (
                                <Square size={12} />
                              )}
                              <span>{e.text?.replace(/\n/g, " ") ?? e.id}</span>
                              {e.locked && <Lock size={10} />}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
                {scene?.annotations.length ? (
                  <div className="layer-module">
                    <h4>整图文字与标注</h4>
                    {allPrimitives(scene.annotations).map((e) => (
                      <button
                        className="layer-row"
                        key={e.id}
                        onClick={() => {
                          setSelection({ elementId: e.id, kind: "primitive" });
                          setFocus("");
                        }}
                      >
                        {e.type === "text" ? <Type size={12} /> : <Square size={12} />}
                        <span>{e.text ?? e.id}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
        <section className="center-panel">
          {error && (
            <div className="error-banner">
              <AlertCircle size={16} />
              <span>{error}</span>
              {scene?.modules.some((m) => m.status !== "ready") && !busy && (
                <button onClick={() => void start(false, true)}>
                  继续未完成模块
                </button>
              )}
              {!run?.scene &&
                run?.planningContext &&
                !!run.drafts?.grounder &&
                !busy && (
                  <button onClick={() => void start(false, false, true)}>
                    从已保存的规划继续
                  </button>
                )}
              <button onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}
          <div className="board-area">
            {run?.visualReference && (showBlueprint||!scene) ? <div className="blueprint-preview">
              <img src={run.visualReference} alt="选中的论文图视觉方案"/>
            </div> : <CanvasEditor
              scene={scene}
              focus={focus}
              selection={selection}
              onFocus={(id) => {
                setFocus(id);
                if (id) setSelection({ moduleId: id });
              }}
              onSelect={setSelection}
              onChange={apply}
              editable={!busy}
            />}
            {!scene && !run?.visualReference && (
              <div className="welcome">
                <div className="welcome-symbol">
                  <Workflow size={31} />
                </div>
                <h1>新建图表</h1>
                <p>导入研究材料，选择图类型后开始生成。</p>
                <button className="button dark" onClick={() => setGenerationOpen(true)}>
                  <Sparkles size={15} /> 生成图表
                </button>
              </div>
            )}
          </div>
          {traceOpen && (
            <div className="trace-panel">
              <div className="trace-header">
                <strong>
                  <Workflow size={14} /> 运行记录
                </strong>
                <span>
                  {run?.status === "running"
                    ? "运行中"
                    : run?.status === "complete"
                      ? "生成结束"
                      : run?.status === "error"
                        ? "发生错误"
                        : "任务记录"}
                </span>
                <button onClick={() => setTraceOpen(false)}>
                  <X size={14} />
                </button>
              </div>
              <div className="trace-events">
                {(run?.events ?? scene?.history ?? []).map((e) => (
                  <div className={"trace-event " + e.status} key={e.id}>
                    <span className="trace-icon">
                      {e.status === "running" ? (
                        <Loader2 className="spin" size={13} />
                      ) : e.status === "complete" ? (
                        <Check size={13} />
                      ) : (
                        <AlertCircle size={13} />
                      )}
                    </span>
                    <b>{roleStage(e.stage)}</b>
                    <span>{e.message}</span>
                  </div>
                ))}
                {!(run?.events ?? scene?.history ?? []).length && (
                  <p className="hint">
                    暂无运行记录。
                  </p>
                )}
              </div>
            </div>
          )}
          <footer className="board-status">
            <span>
              <span className={"status-dot " + (busy ? "working" : "")} />
              {busy
                ? "生成中 · 暂停人工编辑"
                : scene
                  ? "本地自动保存"
                  : "等待研究材料"}
            </span>
            <span>
              {scene?.modules.length ?? 0} 个模块 ·{" "}
              {scene
                ? allPrimitives(scene.modules.flatMap((m) => m.elements))
                    .length + allPrimitives(scene.annotations).length
                : 0}{" "}
              个矢量对象
            </span>
          </footer>
        </section>
        <aside className={"inspector " + (inspectorOpen ? "active" : "")} aria-label="对象属性" aria-hidden={!inspectorOpen}>
          <div className="inspector-header">
            <strong>{selectedElement ? "对象属性" : selectedModule ? "模块属性" : selectedConnector ? "连接属性" : selectedRegion ? "分区属性" : "图表属性"}</strong>
            <button title="关闭属性" aria-label="关闭属性" onClick={() => setInspectorOpen(false)}><X size={16} /></button>
          </div>
          <div className="inspector-scroll">
            {selectedConnector && scene && (
              <>
                <div className="object-type">CONNECTOR · 语义连接</div>
                <label className="field">
                  箭头文字
                  <input
                    value={selectedConnector.label ?? ""}
                    disabled={busy}
                    onChange={(e) =>
                      apply({
                        ...scene,
                        connectors: scene.connectors.map((c) =>
                          c.id === selectedConnector.id
                            ? { ...c, label: e.target.value }
                            : c,
                        ),
                      })
                    }
                  />
                </label>
                {(["from", "to"] as const).map((key) => (
                  <label className="field" key={key}>
                    {key === "from" ? "起点模块" : "终点模块"}
                    <select
                      value={selectedConnector[key]}
                      disabled={busy}
                      onChange={(e) =>
                        apply({
                          ...scene,
                          connectors: scene.connectors.map((c) =>
                            c.id === selectedConnector.id
                              ? {
                                  ...c,
                                  [key]: e.target.value,
                                  [key === "from" ? "fromPort" : "toPort"]:
                                    undefined,
                                  via: undefined,
                                  curve: undefined,
                                  curveAnchors: undefined,
                                }
                              : c,
                          ),
                        })
                      }
                    >
                      {scene.modules.map((m) => (
                        <option value={m.id} key={m.id}>
                          {m.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                {(["from", "to"] as const).map((key) => {
                  const portKey = key === "from" ? "fromPort" : "toPort";
                  const module = scene.modules.find(
                    (m) => m.id === selectedConnector[key],
                  );
                  return (
                    <label className="field" key={portKey}>
                      {key === "from" ? "起点端口" : "终点端口"}
                      <select
                        disabled={busy}
                        value={selectedConnector[portKey] ?? ""}
                        onChange={(e) =>
                          apply({
                            ...scene,
                            connectors: scene.connectors.map((c) =>
                              c.id === selectedConnector.id
                                ? {
                                    ...c,
                                    [portKey]: e.target.value || undefined,
                                    via: undefined,
                                  }
                                : c,
                            ),
                          })
                        }
                      >
                        <option value="">自动边界端口</option>
                        {module?.ports.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.id} · {p.side}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
                <label className="field">
                  颜色
                  <input
                    value={selectedConnector.color ?? scene.style.ink}
                    disabled={busy}
                    onChange={(e) =>
                      apply({
                        ...scene,
                        connectors: scene.connectors.map((c) =>
                          c.id === selectedConnector.id
                            ? { ...c, color: e.target.value, curve: c.curve?.map(({color: _color, ...part}) => part) }
                            : c,
                        ),
                      })
                    }
                  />
                </label>
                <label className="field">
                  中间转折点 · JSON
                  <textarea
                    rows={3}
                    key={selectedConnector.id + "-via"}
                    defaultValue={JSON.stringify(selectedConnector.via ?? [])}
                    onBlur={(e) => {
                      try {
                        const via = JSON.parse(e.target.value);
                        if (
                          !Array.isArray(via) ||
                          via.some(
                            (p) =>
                              !Number.isFinite(p.x) || !Number.isFinite(p.y),
                          )
                        )
                          throw Error("坐标无效");
                        apply({
                          ...scene,
                          connectors: scene.connectors.map((c) =>
                            c.id === selectedConnector.id ? { ...c, via, curve: undefined, curveAnchors: undefined } : c,
                          ),
                        });
                      } catch {
                        setError('转折点格式为 [{"x":100,"y":200}]。');
                      }
                    }}
                  />
                </label>
                {selectedConnector.curve && <label className="field">
                  曲线控制点 · JSON
                  <textarea rows={5} disabled={busy}
                    key={selectedConnector.id + '-curve'}
                    defaultValue={JSON.stringify(selectedConnector.curve)}
                    onBlur={(e) => {
                      try {
                        const curve=JSON.parse(e.target.value);
                        if(!Array.isArray(curve)||!curve.length||curve.some(p=>[p.c1,p.c2,p.end].some(q=>!q||!Number.isFinite(q.x)||!Number.isFinite(q.y))))throw Error('坐标无效');
                        apply({...scene,connectors:scene.connectors.map(c=>c.id===selectedConnector.id?{...c,curve,via:undefined}:c)});
                      } catch {setError('曲线格式为 [{"c1":{"x":100,"y":200},"c2":{"x":150,"y":200},"end":{"x":200,"y":200}}]。');}
                    }}/>
                </label>}
                <label className="field">
                  线宽
                  <input type="number" min="0.5" max="20" step="0.5" disabled={busy}
                    value={selectedConnector.strokeWidth ?? scene.style.lineWidth}
                    onChange={e=>{const width=Number(e.target.value);if(width>=.5&&width<=20)apply({...scene,connectors:scene.connectors.map(c=>c.id===selectedConnector.id?{...c,strokeWidth:width}:c)});}}/>
                </label>
                <button
                  className="full-button"
                  onClick={() =>
                    apply({
                      ...scene,
                      connectors: scene.connectors.map((c) =>
                        c.id === selectedConnector.id
                          ? { ...c, via: undefined, curve: undefined, curveAnchors: undefined, labelAt: undefined }
                          : c,
                      ),
                    })
                  }
                >
                  恢复自动布线
                </button>
                <button
                  className="full-button danger"
                  disabled={busy}
                  onClick={() => {
                    apply({
                      ...scene,
                      connectors: scene.connectors.filter(
                        (c) => c.id !== selectedConnector.id,
                      ),
                    });
                    setSelection({});
                  }}
                >
                  删除连接
                </button>
                <p className="hint">
                  箭头跟随模块。文字可在画板上双击编辑或拖动。
                </p>
              </>
            )}
            {selectedRegion && scene && (
              <>
                <div className="object-type">REGION · 分区背景</div>
                <label className="field">
                  分区标题
                  <input
                    value={selectedRegion.title}
                    disabled={busy}
                    onChange={(e) =>
                      apply({
                        ...scene,
                        regions: scene.regions.map((r) =>
                          r.id === selectedRegion.id
                            ? { ...r, title: e.target.value }
                            : r,
                        ),
                      })
                    }
                  />
                </label>
                <div className="field-grid">
                  {(["x", "y", "width", "height"] as const).map((key) => (
                    <label className="field" key={key}>
                      {key.toUpperCase()}
                      <input
                        type="number"
                        value={selectedRegion[key]}
                        disabled={busy}
                        onChange={(e) =>
                          apply({
                            ...scene,
                            regions: scene.regions.map((r) =>
                              r.id === selectedRegion.id
                                ? { ...r, [key]: Number(e.target.value) }
                                : r,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <label className="field">
                  背景颜色
                  <input
                    value={selectedRegion.fill}
                    disabled={busy}
                    onChange={(e) =>
                      apply({
                        ...scene,
                        regions: scene.regions.map((r) =>
                          r.id === selectedRegion.id
                            ? { ...r, fill: e.target.value }
                            : r,
                        ),
                      })
                    }
                  />
                </label>
                <p className="hint">
                  分区是独立背景对象，移动它不会移动内部模块。
                </p>
              </>
            )}
            {selectedElement && (
              <>
                <div className="object-type">
                  {selectedElement.type.toUpperCase()} <span>原生矢量对象</span>
                </div>
                {selectedElement.type === "text" && (
                  <>
                    <label className="field">
                      文字
                      <textarea
                        aria-label="文字"
                        rows={3}
                        value={selectedElement.text ?? ""}
                        disabled={
                          busy ||
                          selectedElement.locked ||
                          selectedModule?.locked
                        }
                        onChange={(e) =>
                          changeElement({ text: e.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      字号
                      <input
                        aria-label="字号"
                        type="number"
                        min={8}
                        max={100}
                        value={
                          selectedElement.fontSize ?? scene?.style.bodySize
                        }
                        disabled={busy || selectedElement.locked}
                        onChange={(e) =>
                          changeElement({ fontSize: Number(e.target.value) })
                        }
                      />
                    </label>
                  </>
                )}
                <div className="field-grid">
                  {(selectedElement.type === "text"
                    ? (["x", "y", "width"] as const)
                    : ["path", "polygon", "group"].includes(
                          selectedElement.type,
                        )
                      ? (["x", "y", "scaleX", "scaleY"] as const)
                      : (["x", "y", "width", "height"] as const)
                  ).map((key) => (
                    <label className="field" key={key}>
                      {key.toUpperCase()}
                      <input
                        aria-label={key.toUpperCase()}
                        type="number"
                        step={key.startsWith("scale") ? 0.1 : 1}
                        value={
                          selectedElement[key] ??
                          (key.startsWith("scale") ? 1 : 0)
                        }
                        disabled={busy || selectedElement.locked}
                        onChange={(e) =>
                          changeElement({ [key]: Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
                </div>
                <label className="field">
                  填充颜色
                  <input
                    value={selectedElement.fill ?? ""}
                    disabled={busy || selectedElement.locked}
                    onChange={(e) => changeElement({ fill: e.target.value,gradient:undefined })}
                  />
                </label>
                {selectedElement.type!=="text" && <label className="field">填充方式
                  <select aria-label="填充方式" value={selectedElement.gradient ? "gradient" : "solid"} disabled={busy||selectedElement.locked}
                    onChange={e=>changeElement({gradient:e.target.value==="gradient" ? {type:"linear",x1:0,y1:0,x2:0,y2:1,stops:[{offset:0,color:selectedElement.fill?.startsWith('#') ? selectedElement.fill : "#ffffff"},{offset:1,color:"#dbe8f2"}]} : undefined})}>
                    <option value="solid">纯色</option><option value="gradient">线性渐变</option>
                  </select>
                </label>}
                {selectedElement.gradient && <details className="inspector-disclosure" open><summary>渐变颜色</summary>
                  {selectedElement.gradient.stops.map((stop,index)=><label className="field" key={index}>色标 {index+1}
                    <input aria-label={`渐变色标 ${index+1}`} value={stop.color} disabled={busy||selectedElement.locked}
                      onChange={e=>changeElement({gradient:{...selectedElement.gradient!,stops:selectedElement.gradient!.stops.map((s,i)=>i===index?{...s,color:e.target.value}:s)}})}/>
                  </label>)}
                  <label className="field">方向<select aria-label="渐变方向" value={selectedElement.gradient.x2===1 ? "horizontal" : "vertical"} disabled={busy||selectedElement.locked}
                    onChange={e=>changeElement({gradient:{...selectedElement.gradient!,x1:0,y1:0,x2:e.target.value==="horizontal"?1:0,y2:e.target.value==="horizontal"?0:1}})}>
                    <option value="vertical">从上到下</option><option value="horizontal">从左到右</option>
                  </select></label>
                </details>}
                <label className="field">
                  描边颜色
                  <input
                    value={selectedElement.stroke ?? ""}
                    disabled={busy || selectedElement.locked}
                    onChange={(e) => changeElement({ stroke: e.target.value })}
                  />
                </label>
                <div className="action-row">
                  <button
                    disabled={busy || selectedModule?.locked}
                    onClick={() =>
                      changeElement({ locked: !selectedElement.locked })
                    }
                  >
                    {selectedElement.locked ? (
                      <Unlock size={14} />
                    ) : (
                      <Lock size={14} />
                    )}{" "}
                    {selectedElement.locked ? "解锁" : "锁定对象"}
                  </button>
                  <button
                    className="danger"
                    onClick={deleteObject}
                    disabled={
                      busy || selectedElement.locked || selectedModule?.locked
                    }
                  >
                    <Trash2 size={14} /> 删除
                  </button>
                </div>
                <p className="hint">
                  锁定对象在局部重生成中保留。文字也可以在画板内双击修改。
                </p>
              </>
            )}
            {selectedModule && (
              <>
                <div className="module-name">{moduleLabel(selectedModule)}</div>
                <span className="role-chip">{roles[selectedModule.role]}</span>
                {!selectedElement && (
                  <>
                    <div className="field-grid">
                      {(["x", "y", "width", "height"] as const).map((key) => (
                        <label className="field" key={key}>
                          {key.toUpperCase()}
                          <input
                            aria-label={key.toUpperCase()}
                            type="number"
                            value={Math.round(selectedModule[key])}
                            disabled={busy || selectedModule.locked}
                            onChange={(e) =>
                              changeModule({ [key]: Number(e.target.value) })
                            }
                          />
                        </label>
                      ))}
                    </div>
                    <button
                      className="full-button"
                      onClick={() =>
                        setFocus(
                          focus === selectedModule.id ? "" : selectedModule.id,
                        )
                      }
                    >
                      <SquarePen size={14} />{" "}
                      {focus === selectedModule.id
                        ? "退出内部编辑"
                        : "进入模块，编辑内部对象"}
                    </button>
                    <button
                      className="full-button"
                      disabled={busy}
                      onClick={() =>
                        changeModule({ locked: !selectedModule.locked })
                      }
                    >
                      {selectedModule.locked ? (
                        <Unlock size={14} />
                      ) : (
                        <Lock size={14} />
                      )}{" "}
                      {selectedModule.locked ? "解锁模块" : "锁定整个模块"}
                    </button>
                    <button
                      className="full-button danger"
                      disabled={
                        busy ||
                        selectedModule.locked ||
                        allPrimitives(selectedModule.elements).some(
                          (e) => e.locked,
                        )
                      }
                      onClick={() => {
                        if (!scene) return;
                        apply({
                          ...scene,
                          modules: scene.modules.filter(
                            (m) => m.id !== selectedModule.id,
                          ),
                          connectors: scene.connectors.filter(
                            (c) =>
                              c.from !== selectedModule.id &&
                              c.to !== selectedModule.id,
                          ),
                        });
                        setSelection({});
                        setFocus("");
                      }}
                    >
                      <Trash2 size={14} /> 删除模块及其连接
                    </button>
                  </>
                )}
                <div className="divider" />
                <details className="module-regeneration">
                <summary>重新生成此模块</summary>
                <label className="field">
                  生成方法
                  <select
                    value={selectedModule.method}
                    disabled={busy || selectedModule.locked}
                    onChange={(e) => changeModule({ method: e.target.value })}
                  >
                    {Object.entries(methodNames).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  你的修改要求
                  <textarea
                    rows={4}
                    placeholder="例如：保留文字与逻辑，把模型内部画成更细致的张量示意图…"
                    value={localInstruction}
                    onChange={(e) => setLocalInstruction(e.target.value)}
                  />
                </label>
                <button
                  className="local-generate"
                  disabled={busy || selectedModule.locked}
                  onClick={() => void start(true)}
                >
                  <RefreshCw size={14} /> 重生成选中模块
                </button>
                </details>
                <details className="brief">
                  <summary>设计任务与来源</summary>
                  <p>{selectedModule.brief}</p>
                  <p>来源：{selectedModule.sourceRefs.join(", ")}</p>
                  <p>模型：{selectedModule.model}</p>
                </details>
              </>
            )}
            {!selectedModule &&
              !selectedElement &&
              !selectedConnector &&
              !selectedRegion && (
                <>
                  <p className="hint">选中画布或图层中的对象以编辑。</p>
                  {scene && (
                    <>
                      <label className="field">
                        图标题
                        <input
                          value={scene.title}
                          disabled={busy}
                          onChange={(e) =>
                            apply({ ...scene, title: e.target.value })
                          }
                        />
                      </label>
                      <button
                        className="full-button"
                        onClick={() => setShowPlan(!showPlan)}
                      >
                        <FileText size={14} /> {showPlan ? "收起" : "查看"}
                        科学内容与视觉方案
                      </button>
                      {showPlan && (
                        <div className="plan-text">
                          <h4>{scene.semanticPlan?.message}</h4>
                          <p>{scene.designRationale}</p>
                          {scene.semanticPlan?.constraints.map((c, i) => (
                            <p key={i}>• {c}</p>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            {scene?.review && (
              <div className={"review-card " + scene.review.status}>
                <div>
                  <Check size={15} />
                  <strong>
                    {scene.review.status === "reviewed"
                      ? "已检查实际渲染"
                      : scene.review.status === "unavailable"
                        ? "审查不可用"
                        : "仍需人工检查 / 修订"}
                  </strong>
                </div>
                <details>
                  <summary>检查记录 · {scene.review.issues.length} 条</summary>
                  <p>{scene.review.summary}</p>
                {scene.review.issues.map((issue, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (issue.moduleId)
                        layerPick(issue.moduleId, issue.elementId);
                    }}
                  >
                    <span className={"severity " + issue.severity}>
                      {issue.severity}
                    </span>
                    {issue.message}
                  </button>
                ))}
                </details>
              </div>
            )}
          </div>
        </aside>
      </main>
      {generationOpen && <GenerationDialog tab={generationTab} onTabChange={setGenerationTab} onClose={() => setGenerationOpen(false)}
        actions={<>
          <span className="generation-status">{materials.length} 个材料 · {figureApiConfigured ? "API 已配置" : "API 未配置"}</span>
          <>
            <button
              className="generate-button"
              onClick={() => void start()}
              disabled={busy || !figureApiConfigured}
            >
              {busy ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <Sparkles size={17} />
              )}{" "}
              {busy
                ? "正在生成…"
                : scene
                  ? "重新生成整图"
                  : "开始生成"}
              {!busy && <ArrowRight size={16} />}
            </button>
            {busy && (
              <button
                className="cancel"
                onClick={() =>
                  void api("/api/runs/" + runId + "/cancel", jsonPost({}))
                }
              >
                <StopCircle size={13} /> 停止任务
              </button>
            )}
          </>

        </>}>
        {error && <div className="generation-error" role="alert">{error}</div>}
        {generationTab === "figure" ? <>
          <details className="generation-materials" open={!materials.length}><summary>研究材料 · {materials.length} 个文件</summary>{materialPanel}</details>
          {figureSettings}
        </> : modelSettings}
      </GenerationDialog>}
      {toast && (
        <div className="toast">
          <Check size={15} />
          {toast}
        </div>
      )}
    </div>
  );
}

import type { MethodDefinition, ModuleId } from "./paper-types";

const upstream =
  "https://github.com/google-research/paper-orchestra/blob/ca1b3fa01c2970fc7cda32d16245db38d57b3f56/";
const textModules: ModuleId[] = [
  "abstract",
  "introduction",
  "related_work",
  "method",
  "experiments",
  "conclusion",
];
export const paperMethods: MethodDefinition[] = [
  {
    id: 'grounded-section', name: '证据规划 → 写作 → 修订', modules: textModules, origin: 'native', version: '1.0.0',
    description: '先建立材料边界，再写作、审查并修正不受支持的细节。',
    stages: ['证据边界','章节写作','事实审查','针对性修订'], requiresModel: true,
    capabilities: ['markdown','math','tables','claim-audit','revision'],
  },
  {
    id: 'grounded-literature', name: '多源文献调查', modules: ['references'], origin: 'native', version: '1.0.0',
    description: '分主题检索、元数据去重、摘要相关性筛选。', stages: ['调查规划','OpenAlex / Crossref','相关性审查'],
    requiresModel: true, capabilities: ['bibliography','abstract-grounding'],
  },
  {
    id: 'publication-figures', name: 'AI 视觉方案 → 保真矢量重建', modules: ['figures'], origin: 'native', version: '2.0.0',
    description: '生成并选择视觉蓝图，拆解几何与插画，子代理重建元素，按原图组装并对照修订；统计图绑定材料数据。',
    stages: ['实验数据解析','视觉方案比较','元素与素材拆解','插画子代理','原图坐标组装','视觉保真修订'], requiresModel: true,
    capabilities: ['native-objects','svg','evidence-charts','visual-review','blueprint-reconstruction'],
  },
  {
    id: 'vector-design-figures', name: '自由矢量设计（原流程）', modules: ['figures'], origin: 'native', version: '1.0.0',
    description: '从语义规划独立设计模块，再进行矢量生成与全局组装；不以保留图像蓝图几何为目标。',
    stages: ['实验数据解析','视觉方案比较','语义模块设计','矢量对象生成','视觉审查'],requiresModel:true,
    capabilities:['native-objects','svg','evidence-charts','visual-review'],
  },
  {
    id: "orchestra-outline",
    name: "Orchestra · 结构化规划",
    modules: ["outline"],
    origin: "PaperOrchestra-adapted",
    version: "0.1.0",
    requiresModel: true,
    description:
      "复用上游大纲提示词，将章节、文献调查和图表需求规划为结构化结果。",
    stages: ["材料约束", "大纲与图表规划", "结构校验"],
    capabilities: ["outline", "figure-brief"],
    source: upstream + "methods/prompts/outline_agent.py",
    limitations:
      "仅复用规划策略，不运行上游整篇生成程序；idea-only 的实验必须标为待补充。",
  },
  {
    id: "orchestra-literature",
    name: "Orchestra-derived · 引用检索",
    modules: ["references"],
    origin: "PaperOrchestra-adapted",
    version: "0.1.0",
    requiresModel: true,
    description:
      "从规划生成检索任务，查询 Semantic Scholar、去重并建立共享引用库。",
    stages: ["检索任务规划", "Semantic Scholar 检索", "元数据整理"],
    capabilities: ["bibliography"],
    source: upstream + "methods/agents/literature_review_agent.py",
    limitations:
      "替换了上游 Gemini Google Search 发现步骤；元数据核验不等于全文论据核验。检索服务不可用时明确失败。",
  },
  {
    id: "orchestra-section",
    name: "Orchestra · 章节写作",
    modules: textModules,
    origin: "PaperOrchestra-adapted",
    version: "0.1.0",
    requiresModel: true,
    description:
      "复用上游文学综述/正文写作提示词，适配为只返回当前章节，不生成或覆盖整篇 LaTeX。",
    stages: ["上下文与引用约束", "单章节写作", "引用键检查"],
    capabilities: ["markdown", "math", "tables"],
    source: upstream + "methods/prompts/section_writing_agent.py",
    limitations:
      "Markdown 模块协议替代上游全文 LaTeX 输出；不强制引用比例，不补造实验、作者或论据。",
  },
  {
    id: "evidence-first",
    name: "Evidence-first · 论证规划后写作",
    modules: textModules,
    origin: "native",
    version: "0.1.0",
    requiresModel: true,
    description:
      "先建立论点—材料对应计划，再写当前章节，最后执行独立事实与引用审查。",
    stages: ["论证与证据规划", "章节写作", "独立事实审查"],
    capabilities: ["markdown", "claim-audit"],
  },
  {
    id: "orchestra-refine",
    name: "Orchestra · 审查后修订",
    modules: textModules,
    origin: "PaperOrchestra-adapted",
    version: "0.1.0",
    requiresModel: true,
    description:
      "先审查当前章节，再利用上游修订策略产生候选版本；不足和缺失证据仍需明确列出。",
    stages: ["当前章节审查", "针对性修订", "引用键检查"],
    capabilities: ["revision", "claim-audit"],
    source: upstream + "methods/prompts/content_refinement_agent.py",
    limitations:
      "不执行上游全文循环，不追求自评分最大化，也不沿用隐藏局限性等指令。",
  },
  {
    id: "vector-atelier",
    name: "Paper Studio · 可编辑矢量画板",
    modules: ["figures"],
    origin: "native",
    version: "1.0.0",
    requiresModel: false,
    description:
      "打开现有画板，选择绘图方法、模型和图类型；将矢量对象、图注作为候选提交回主稿。",
    stages: ["图需求", "视觉设计与子模块", "画板编辑", "提交候选"],
    capabilities: ["native-objects", "svg", "local-edit"],
    limitations:
      "画板内 AI 生成另需 API；当前视觉质量仍需人工检查，不声称达到投稿标准。",
  },
];
export function defaultMethod(id: ModuleId): string {
  return id === "outline"
    ? "orchestra-outline"
    : id === "references"
      ? "grounded-literature"
      : id === "figures"
        ? "publication-figures"
        : "grounded-section";
}
export function findMethod(id: string, moduleId: ModuleId): MethodDefinition {
  const method = paperMethods.find(
    (m) => m.id === id && m.modules.includes(moduleId),
  );
  if (!method) throw Error("该方法不支持当前模块");
  return method;
}

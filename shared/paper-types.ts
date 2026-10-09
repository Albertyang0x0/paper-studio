import type { FigureScene } from "./types";

export const moduleOrder = [
  "outline",
  "references",
  "introduction",
  "related_work",
  "method",
  "experiments",
  "abstract",
  "conclusion",
  "figures",
] as const;
export type ModuleId = (typeof moduleOrder)[number];
export const moduleLabels: Record<ModuleId, string> = {
  outline: "论文规划",
  references: "文献与引用",
  introduction: "Introduction",
  related_work: "Related Work",
  method: "Method",
  experiments: "Experiments",
  abstract: "Abstract",
  conclusion: "Conclusion",
  figures: "图表与画板",
};
export const manuscriptOrder: ModuleId[] = [
  "abstract",
  "introduction",
  "related_work",
  "method",
  "experiments",
  "figures",
  "conclusion",
  "references",
];
export const moduleDependencies: Record<ModuleId, ModuleId[]> = {
  outline: [],
  references: ["outline"],
  introduction: ["outline", "method", "references"],
  related_work: ["outline", "references"],
  method: ["outline"],
  experiments: ["outline", "method"],
  abstract: ["introduction", "method", "experiments"],
  conclusion: ["method", "experiments"],
  figures: ["method", "experiments"],
};
export interface PaperMaterial {
  id: string;
  name: string;
  role: "idea" | "experiment" | "context";
  content: string;
}
export interface PaperTemplate {
  name: string;
  entry: string;
  files: { name: string; content: string }[];
}
export interface Citation {
  id: string;
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  abstract: string;
  url: string;
  doi?: string;
  verification: "metadata-verified" | "user-provided";
  verifiedAt?: string;
  provider: string;
}
export interface FigureAsset {
  id: string;
  figureId: string;
  version: number;
  title: string;
  caption: string;
  scene: FigureScene;
  createdAt: string;
  key?: string;
  placement?: 'introduction' | 'method' | 'experiments';
  provenance?: { method: string; models: string[]; sourceNames: string[]; designReference?: string };
}
export interface ModuleVersion {
  revision: number;
  content: string;
  assetIds: string[];
  methodId: string;
  model: string;
  reason: string;
  createdAt: string;
  warnings: string[];
  candidateId?: string;
}
export interface PaperModule {
  connectionId?: string;
  imageConnectionId?: string;
  imageModel?: string;
  id: ModuleId;
  content: string;
  revision: number;
  methodId: string;
  model: string;
  locked: boolean;
  needsSync: string[];
  assetIds: string[];
  history: ModuleVersion[];
}
export interface Candidate {
  id: string;
  moduleId: ModuleId;
  runId: string;
  baseRevision: number;
  sourceRevision: number;
  dependencyVersions: Partial<Record<ModuleId, number>>;
  methodId: string;
  model: string;
  content: string;
  warnings: string[];
  citations?: Citation[];
  assets?: FigureAsset[];
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  outlineData?: Record<string, unknown>;
  editedFromCandidateId?: string;
}
export interface PaperProject {
  schema: "paper-workbench/1";
  id: string;
  title: string;
  ideaSpark: string;
  language: "en" | "zh";
  guidelines: string;
  revision: number;
  sourceRevision: number;
  createdAt: string;
  updatedAt: string;
  materials: PaperMaterial[];
  template?: PaperTemplate;
  modules: Record<ModuleId, PaperModule>;
  citations: Citation[];
  assets: FigureAsset[];
  candidates: Candidate[];
  outlineData?: Record<string, unknown>;
  events: { id: string; time: string; action: string; moduleId?: ModuleId }[];
}
export interface MethodDefinition {
  id: string;
  name: string;
  modules: ModuleId[];
  origin: "PaperOrchestra-adapted" | "native";
  description: string;
  stages: string[];
  requiresModel: boolean;
  capabilities: string[];
  version: string;
  source?: string;
  limitations?: string;
}
// This is the boundary for independently developed adapters. No adapter mutates a project.
export interface ModuleInput {
  connectionId?: string;
  imageConnectionId?: string;
  imageModel?: string;
  contract: "paper-module/1";
  project: Readonly<PaperProject>;
  moduleId: ModuleId;
  methodId: string;
  model: string;
  instruction: string;
  signal?: AbortSignal;
}
export interface ModuleOutput {
  content: string;
  warnings: string[];
  citations?: Citation[];
  assets?: FigureAsset[];
  outlineData?: Record<string, unknown>;
}
export interface PaperRun {
  id: string;
  projectId: string;
  baseProjectRevision: number;
  mode: "module" | "draft";
  status: "running" | "complete" | "partial" | "error" | "cancelled" | "interrupted";
  createdAt: string;
  candidateIds: string[];
  events: { stage: string; message: string; time: string }[];
  error?: string;
  moduleFailures?: { moduleId: ModuleId; message: string }[];
  review?: { rounds: number; issues: { moduleId: ModuleId; severity: string; message: string }[]; summary: string };
  configuration?: {
    modules: ModuleId[];
    methods: Partial<Record<ModuleId, string>>;
    models: Partial<Record<ModuleId, string>>;
    connections?: Partial<Record<ModuleId, string>>;
    imageConnections?: Partial<Record<ModuleId, string>>;
    imageModels?: Partial<Record<ModuleId, string>>;
    instruction: string;
    skipReferenceSearch: boolean;
    reviewRounds?: number;
  };
}

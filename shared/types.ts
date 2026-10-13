export type WorkerRole = "illustration" | "structure" | "plot";
export type WorkerMethod = "vector-agent" | "asset-assisted" | "diagram-agent";
export type Point = { x: number; y: number };
export type Side = "left" | "right" | "top" | "bottom";
export interface Material {
  id: string;
  name: string;
  content: string;
}
export interface Reference {
  id: string;
  name: string;
  url: string;
  description?: string;
  dataUrl?: string;
}
export interface StyleTokens {
  font: string;
  ink: string;
  muted: string;
  accent: string;
  palette: string[];
  lineWidth: number;
  bodySize: number;
  titleSize: number;
  illustrationStyle: string;
  minimumFontSize?: number;
}
export interface SemanticPlan {
  title: string;
  message: string;
  components: {
    id: string;
    label: string;
    meaning: string;
    sourceRefs: string[];
  }[];
  relationships: { from: string; to: string; meaning: string }[];
  constraints: string[];
}
export interface SceneImageAsset {
  mimeType: "image/png" | "image/jpeg";
  dataUrl: string;
  width: number;
  height: number;
}
export interface PrimitiveClip {
  /** Path in the primitive's local coordinate system. Multiple clips intersect. */
  path: string;
  fillRule?: "nonzero" | "evenodd";
}
export interface SvgShadow {
  /** The supported SVG filter produces only the shadow, not SourceGraphic. */
  dx: number;
  dy: number;
  spread: number;
  /** Original linear-RGB matrix constants encoded as rgba(R*255,G*255,B*255,A). */
  color: string;
  knockout: boolean;
  region: { x: number; y: number; width: number; height: number };
}
export interface Primitive {
  id: string;
  type:
    | "rect"
    | "ellipse"
    | "text"
    | "path"
    | "line"
    | "polygon"
    | "group"
    | "image"
    | "symbol";
  x: number;
  y: number;
  width?: number;
  height?: number;
  fill?: string;
  gradient?: {
    type: "linear";
    x1: number; y1: number; x2: number; y2: number;
    stops: { offset: number; color: string; opacity?: number }[];
  };
  layer?: "background" | "foreground";
  stroke?: string;
  strokeWidth?: number;
  fillRule?: "nonzero" | "evenodd";
  strokeLineCap?: "butt" | "round" | "square";
  strokeLineJoin?: "miter" | "round" | "bevel";
  strokeMiterLimit?: number;
  strokeDashOffset?: number;
  paintOrder?: "fill stroke" | "stroke fill";
  radius?: number;
  text?: string;
  containerId?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  /** Extra spacing between characters in the primitive's local SVG units. */
  letterSpacing?: number;
  /** A native, editable underline carried by imported SVG text. */
  underline?: boolean;
  align?: "left" | "center" | "right";
  italic?: boolean;
  path?: string;
  points?: Point[];
  dash?: number[];
  opacity?: number;
  rotation?: number;
  children?: Primitive[];
  assetId?: string;
  clip?: PrimitiveClip[];
  svgShadow?: SvgShadow;
  symbol?: string;
  locked?: boolean;
  sourceRefs?: string[];
  scaleX?: number;
  scaleY?: number;
  componentIds?: string[];
}
export interface ModuleBrief {
  id: string;
  title: string;
  role: WorkerRole;
  brief: string;
  componentIds: string[];
  labels: string[];
  sourceRefs: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  ports: { id: string; side: Side; offset: number; anchor?: Point }[];
  allowOverlapWith?: string[];
}
export interface Region {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  dash?: boolean;
}
export interface Connector {
  id: string;
  from: string;
  to: string;
  fromPort?: string;
  toPort?: string;
  label?: string;
  color?: string;
  dash?: boolean;
  via?: Point[];
  labelAt?: Point;
  curve?: { c1: Point; c2: Point; end: Point; color?: string }[];
  curveAnchors?: { start: Point; end: Point };
  strokeWidth?: number;
}
export interface DesignPlan {
  title: string;
  width: number;
  height: number;
  rationale: string;
  style: StyleTokens;
  regions: Region[];
  modules: ModuleBrief[];
  connectors: Connector[];
  annotations: Primitive[];
}
export interface SceneModule extends ModuleBrief {
  method: WorkerMethod;
  elements: Primitive[];
  status: "ready" | "pending" | "error";
  model?: string;
  generation?: string;
  locked?: boolean;
  contentWidth?: number;
  contentHeight?: number;
}
/** A logical editing selection; source objects keep their original paint order. */
export interface GroupMember {
  kind: "module" | "primitive" | "group";
  id: string;
  moduleId?: string;
}
export interface ManualGroup {
  id: string;
  title: string;
  /** Absent for whole-figure groups; otherwise members use this module's frame. */
  moduleId?: string;
  members: GroupMember[];
}
export interface FigureScene {
  schema: "paper-atelier/1";
  id: string;
  title: string;
  width: number;
  height: number;
  publicationWidthPt?: number;
  style: StyleTokens;
  regions: Region[];
  modules: SceneModule[];
  connectors: Connector[];
  annotations: Primitive[];
  manualGroups?: ManualGroup[];
  assets?: Record<string, SceneImageAsset>;
  semanticPlan?: SemanticPlan;
  designRationale?: string;
  materials?: Material[];
  references?: Reference[];
  review?: Review;
  history?: RunEvent[];
  agentConfig?: AgentConfig;
  intent?: string;
  figureType?: string;
  reconstruction?: {
    version: 1;
    referenceId: string;
    assetIds: string[];
    iterations: number;
    fidelityPassed: boolean;
  };
}
export interface Review {
  status: "reviewed" | "unavailable" | "needs-revision";
  summary: string;
  issues: {
    moduleId?: string;
    elementId?: string;
    severity: "low" | "medium" | "high";
    message: string;
  }[];
  checks?: Record<string, boolean>;
}
export interface RunEvent {
  id: string;
  stage: string;
  status: "running" | "complete" | "error" | "warning";
  message: string;
  time: string;
}
export interface AgentConfig {
  connections?: Partial<Record<"planner" | "director" | "worker" | "assembler" | "critic" | "image", string>>;
  pipeline?: "visual-reconstruction" | "vector-design";
  imageModel?: string;
  fidelityRounds?: number;
  planner: string;
  director: string;
  worker: string;
  assembler: string;
  critic: string;
  methods: Record<WorkerRole, WorkerMethod>;
  reviewRounds: number;
}
export interface RunInput {
  materials: Material[];
  references: Reference[];
  intent: string;
  figureType: string;
  config: AgentConfig;
  scene?: FigureScene;
  moduleId?: string;
  instruction?: string;
  resumeScene?: FigureScene;
  resumePlanning?: PlanningCheckpoint;
  resumeDrafts?: Record<string, unknown>;
  publicationWidthPt?: number;
  visualReference?: string;
}
export interface PlanningCheckpoint {
  materials: Material[];
  intent: string;
  figureType: string;
  semanticPlan: SemanticPlan;
  designDraft?: DesignPlan;
}
export interface RunRecord {
  id: string;
  status: "running" | "complete" | "error" | "cancelled";
  events: RunEvent[];
  scene?: FigureScene;
  error?: string;
  visualReference?: string;
  drafts?: Record<string, unknown>;
  planningContext?: {
    materials: Material[];
    intent: string;
    figureType: string;
  };
}

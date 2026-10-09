import type { Connector, FigureScene, Primitive, SemanticPlan, StyleTokens } from "./types";

export interface VisualAsset {
  id: string;
  name: string;
  brief: string;
  crop: { x: number; y: number; width: number; height: number };
  width: number;
  height: number;
}
export interface VisualNode {
  id: string;
  title: string;
  x: number; y: number; width: number; height: number;
  elements: Primitive[];
  componentIds: string[];
  sourceRefs: string[];
  ports: { id: string; side: "left" | "right" | "top" | "bottom"; offset: number; anchor?: {x:number;y:number} }[];
  assets: { assetId: string; x: number; y: number; width: number; height: number }[];
  allowOverlapWith?: string[];
}
export interface ReconstructionPlan {
  title: string;
  width: number;
  height: number;
  rationale: string;
  style: StyleTokens;
  backgrounds: Primitive[];
  nodes: VisualNode[];
  annotations: Primitive[];
  connectors: Connector[];
  assets: VisualAsset[];
}
export interface ReconstructionCheckpoint {
  version: 1;
  semantic: SemanticPlan;
  plan: ReconstructionPlan;
  assets: Record<string, Primitive[]>;
  nodes?: Record<string, Primitive[]>;
  sourceFingerprint?: string;
  geometryCalibrated?: boolean;
  assetGeometryCalibrated?: boolean;
  surfacePlanned?: boolean;
  routingPlanned?: boolean;
  scene?: FigureScene;
}

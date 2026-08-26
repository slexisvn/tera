import type { AllocationReport } from "tera";

export type StageGroup =
  | "frontend"
  | "bytecode"
  | "executed"
  | "module"
  | "middle-end"
  | "lowering"
  | "machine"
  | "codegen";

export type StageKind = "text" | "ir" | "machine" | "bytecode" | "diagnostics";

export type StageMetrics = {
  readonly nodesBefore: number;
  readonly nodesAfter: number;
};

export type RemarkKind = "missed" | "applied" | "analysis";

export type StageRemark = {
  readonly kind: RemarkKind;
  readonly node: string | null;
  readonly message: string;
};

export const REMARK_TITLES: Record<RemarkKind, string> = {
  missed: "Did not fire",
  applied: "Fired",
  analysis: "About the pass",
};

export type Stage = {
  readonly id: string;
  readonly group: StageGroup;
  readonly kind: StageKind;
  readonly title: string;
  readonly subtitle: string;
  readonly owner: string;
  readonly ordinal: number;
  readonly changed: boolean;
  readonly failed: boolean;
  readonly text: string;
  readonly passName: string | null;
  readonly metrics: StageMetrics | null;
  readonly requires: readonly string[];
  readonly invalidated: readonly string[];
  readonly remarks: readonly StageRemark[];
  readonly allocation: AllocationReport | null;
  readonly positions: Readonly<Record<string, number>>;
};

export const NO_REMARKS: readonly StageRemark[] = [];
export const NO_ANALYSES: readonly string[] = [];

export type ShapeEdge = {
  readonly kind: "add" | "delete";
  readonly from: number;
  readonly to: number;
  readonly property: string;
  readonly properties: number | null;
};

export const NO_POSITIONS: Readonly<Record<string, number>> = {};

export type DeoptOrigin = {
  readonly owner: string;
  readonly reason: string;
  readonly node: string | null;
  readonly opcode: string | null;
  readonly line: number | null;
  readonly candidates: readonly string[];
};

export type RuntimeEvent = {
  readonly category: string;
  readonly message: string;
  readonly at: number;
  readonly origin: DeoptOrigin | null;
};

export type PipelineId = "jit" | "aot";

export type OptLevelId = "none" | "baseline" | "speed" | "max";

export type RunRequest = {
  readonly source: string;
  readonly pipeline: PipelineId;
  readonly optLevel: OptLevelId;
  readonly target: string;
};

export type RunResult = {
  readonly stages: readonly Stage[];
  readonly events: readonly RuntimeEvent[];
  readonly dropped: Readonly<Record<string, number>>;
  readonly output: readonly string[];
  readonly outputDropped: number;
  readonly shapes: readonly ShapeEdge[];
  readonly error: string | null;
  readonly runError: string | null;
  readonly elapsedMs: number;
};

export type LabRequest = {
  readonly text: string;
  readonly pass: string;
  readonly optLevel: OptLevelId;
};

export type LabResult = {
  readonly before: string;
  readonly after: string;
  readonly remarks: readonly StageRemark[];
  readonly error: string | null;
};

export type TargetInfo = {
  readonly id: string;
  readonly pipeline: PipelineId;
  readonly label: string;
};

export const VISUALIZER_PASS_NAMES = [
  "tokenize",
  "parse",
  "typecheck",
  "bytecode",
  "codegen",
  "declined",
  "executed-graph",
] as const;

export type VisualizerPassName = (typeof VISUALIZER_PASS_NAMES)[number];

export const GROUP_ORDER: readonly StageGroup[] = [
  "frontend",
  "bytecode",
  "executed",
  "module",
  "middle-end",
  "lowering",
  "machine",
  "codegen",
];

export const GROUP_TITLES: Record<StageGroup, string> = {
  frontend: "Frontend",
  bytecode: "Bytecode",
  executed: "What actually ran",
  module: "Module lowering",
  "middle-end": "Middle end",
  lowering: "Target lowering",
  machine: "Machine IR",
  codegen: "Code generation",
};

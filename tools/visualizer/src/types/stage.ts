export type StageGroup =
  | "frontend"
  | "bytecode"
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

export type Stage = {
  readonly id: string;
  readonly group: StageGroup;
  readonly kind: StageKind;
  readonly title: string;
  readonly subtitle: string;
  readonly owner: string;
  readonly ordinal: number;
  readonly changed: boolean;
  readonly text: string;
  readonly passName: string | null;
  readonly metrics: StageMetrics | null;
  readonly invalidated: readonly string[];
  readonly positions: Readonly<Record<string, number>>;
};

export const NO_POSITIONS: Readonly<Record<string, number>> = {};

export type RuntimeEvent = {
  readonly category: string;
  readonly message: string;
  readonly at: number;
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
  /** Events the per-category budget refused, so the timeline can say so. */
  readonly dropped: Readonly<Record<string, number>>;
  readonly error: string | null;
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
  readonly error: string | null;
};

export type TargetInfo = {
  readonly id: string;
  readonly pipeline: PipelineId;
  readonly label: string;
};

export const GROUP_ORDER: readonly StageGroup[] = [
  "frontend",
  "bytecode",
  "module",
  "middle-end",
  "lowering",
  "machine",
  "codegen",
];

export const GROUP_TITLES: Record<StageGroup, string> = {
  frontend: "Frontend",
  bytecode: "Bytecode",
  module: "Module lowering",
  "middle-end": "Middle end",
  lowering: "Target lowering",
  machine: "Machine IR",
  codegen: "Code generation",
};

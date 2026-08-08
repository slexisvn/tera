export type SpeculationKind =
  | "deopt-to-interpreter"
  | "guard-with-slowpath"
  | "prove-or-generic";

export interface SpeculationStrategy {
  readonly kind: SpeculationKind;
  readonly needsFrameState: boolean;
}

export const deoptToInterpreter: SpeculationStrategy = {
  kind: "deopt-to-interpreter",
  needsFrameState: true,
};

export const guardWithSlowPath: SpeculationStrategy = {
  kind: "guard-with-slowpath",
  needsFrameState: false,
};

export const proveOrGeneric: SpeculationStrategy = {
  kind: "prove-or-generic",
  needsFrameState: false,
};

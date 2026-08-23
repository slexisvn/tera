export type Capability =
  | "deopt"
  | "osr"
  | "tagged-values"
  | "terminating-throw"
  | "float-text"
  | "select-integer"
  | "select-float"
  | "generational-heap"
  | "timers";

export type CapabilitySet = ReadonlySet<Capability>;

export function capabilitySet(...caps: Capability[]): CapabilitySet {
  return new Set(caps);
}

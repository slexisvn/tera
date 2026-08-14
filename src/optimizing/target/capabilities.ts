export type Capability =
  | "deopt"
  | "osr"
  | "tagged-values"
  | "terminating-throw"
  | "float-text";

export type CapabilitySet = ReadonlySet<Capability>;

export function capabilitySet(...caps: Capability[]): CapabilitySet {
  return new Set(caps);
}

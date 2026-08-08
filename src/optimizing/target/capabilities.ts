export type Capability =
  | "native-pointer"
  | "linear-memory"
  | "host-gc"
  | "own-gc"
  | "deopt"
  | "osr"
  | "tail-call"
  | "int64";

export type CapabilitySet = ReadonlySet<Capability>;

export function capabilitySet(...caps: Capability[]): CapabilitySet {
  return new Set(caps);
}

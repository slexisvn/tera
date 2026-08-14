import type { TaggedValue } from "../core/value/index.js";
import type { Environment } from "../runtime/intrinsics/environment.js";

export class DeoptSignal {
  reason: string;
  bytecodeOffset: number;
  frameStateId: number;
  runtimeValues: Map<number, TaggedValue>;
  closureEnv: Environment | null;

  constructor(
    reason: string,
    bytecodeOffset: number,
    frameStateId = -1,
    runtimeValues: Map<number, TaggedValue> = new Map(),
    closureEnv: Environment | null = null,
  ) {
    this.reason = reason;
    this.bytecodeOffset = bytecodeOffset;
    this.frameStateId = frameStateId;
    this.runtimeValues = runtimeValues;
    this.closureEnv = closureEnv;
  }

  toString(): string {
    return `DeoptSignal(fs=${this.frameStateId}, reason="${this.reason}", bc=${this.bytecodeOffset})`;
  }
}

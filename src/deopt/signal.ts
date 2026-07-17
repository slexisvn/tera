import type { TaggedValue } from "../core/value/index.js";

export class DeoptSignal {
  reason: string;
  bytecodeOffset: number;
  stack: TaggedValue[];
  locals: TaggedValue[];
  frameStateId: number;
  runtimeValues: Map<number, TaggedValue>;

  constructor(
    reason: string,
    bytecodeOffset: number,
    stack: TaggedValue[],
    locals: TaggedValue[],
    frameStateId = -1,
    runtimeValues: Map<number, TaggedValue> = new Map(),
  ) {
    this.reason = reason;
    this.bytecodeOffset = bytecodeOffset;
    this.stack = stack;
    this.locals = locals;
    this.frameStateId = frameStateId;
    this.runtimeValues = runtimeValues;
  }

  toString(): string {
    return `DeoptSignal(fs=${this.frameStateId}, reason="${this.reason}", bc=${this.bytecodeOffset})`;
  }
}

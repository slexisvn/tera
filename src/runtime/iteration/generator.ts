export const GEN_NEWBORN = "newborn";
export const GEN_EXECUTING = "executing";
export const GEN_SUSPENDED = "suspended";
export const GEN_COMPLETED = "completed";

export type GeneratorState =
  | typeof GEN_NEWBORN
  | typeof GEN_EXECUTING
  | typeof GEN_SUSPENDED
  | typeof GEN_COMPLETED;

export class GeneratorObject {
  frame: RegisterFrame;
  interpreter: { runFrame(frame: RegisterFrame): TaggedValue };
  state: GeneratorState;

  constructor(frame: RegisterFrame, interpreter: { runFrame(frame: RegisterFrame): TaggedValue }) {
    this.frame = frame;
    this.interpreter = interpreter;
    this.state = GEN_NEWBORN;
  }
}

export class GeneratorSuspend {
  value: TaggedValue;

  constructor(value: TaggedValue) {
    this.value = value;
  }
}
import type { TaggedValue } from "../../core/value/index.js";
import type { RegisterFrame } from "../../bytecode/register/interpreter/frame.js";

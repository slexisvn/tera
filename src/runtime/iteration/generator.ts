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
  interpreter: GeneratorInterpreter;
  state: GeneratorState;

  constructor(frame: RegisterFrame, interpreter: GeneratorInterpreter) {
    this.frame = frame;
    this.interpreter = interpreter;
    this.state = GEN_NEWBORN;
    interpreter.suspendedFrames.set(frame, this);
  }
}

export class GeneratorSuspend {
  value: TaggedValue;

  constructor(value: TaggedValue) {
    this.value = value;
  }
}
import type { TaggedValue } from "../../core/value/index.js";
import type { RegisterFrame, SuspendedFrameRoots } from "../../bytecode/register/interpreter/frame.js";

type GeneratorInterpreter = SuspendedFrameRoots & {
  runFrame(frame: RegisterFrame): TaggedValue;
};

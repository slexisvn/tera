import * as bytecode from "../ops/bytecode.js";
import type {
  RegisterCompiledFunction,
  RegisterInstruction,
  RegisterOperand,
} from "../ops/bytecode.js";
import type { TaggedValue } from "../../../core/value/index.js";
import type { RegisterFrame } from "./frame.js";

import {
  mkString,
  mkBool,
  mkObject,
  mkFunction,
  getPayload,
  getTag,
} from "../../../core/value/index.js";

import { createJSObject } from "../../../objects/heap/factory.js";
import { PROMISE_FULFILLED } from "../../../runtime/async/promise.js";
import { DEFAULT_TIERING_POLICY } from "../../../runtime/tiering/policy.js";
import { VMError, vmErrorToTagged } from "../../../core/errors/index.js";
import { createIteratorResult } from "../../../runtime/iteration/iterator.js";
import {
  GeneratorSuspend,
  GEN_EXECUTING,
  GEN_SUSPENDED,
  GEN_COMPLETED,
} from "../../../runtime/iteration/generator.js";

export const MAX_DEOPT_COUNT = DEFAULT_TIERING_POLICY.maxDeoptCount;

type FeedbackSlotLike = {
  isStable: boolean;
  recordBinaryOp(leftTag: string, rightTag: string): void;
};

type FeedbackVectorLike = {
  saturated?: boolean;
  getSlot(index: number): FeedbackSlotLike | null | undefined;
};

type BinaryFrameLike = {
  acc: TaggedValue;
  getReg(index: number): TaggedValue;
};

type AsyncFrameLike = RegisterFrame;

type PromiseLikeRecord = {
  addReaction(callback: (state: string, result: TaggedValue) => void): void;
};

type AsyncCapability = {
  resolve(value: TaggedValue): void;
  reject(reason: TaggedValue): void;
};

type AsyncInterpreterLike = {
  runFrame(frame: AsyncFrameLike): TaggedValue;
  microtaskQueue?: { drain(): void };
};

type CompiledFunctionWithFeedback = RegisterCompiledFunction & {
  feedbackVector: FeedbackVectorLike | null;
};

export const INTERPRETER_ONLY_OPS: Set<number> = new Set([
  bytecode.ROP_AWAIT,
  bytecode.ROP_GET_ITERATOR,
  bytecode.ROP_ITER_NEXT,
  bytecode.ROP_ITER_DONE,
  bytecode.ROP_ITER_VALUE,
  bytecode.ROP_YIELD,
  bytecode.ROP_LOAD_ARGUMENTS,
  bytecode.ROP_TRY_START,
  bytecode.ROP_TRY_END,
  bytecode.ROP_THROW,
]);

export function requiresInterpreterOnly(compiledFn: RegisterCompiledFunction): boolean {
  return (
    compiledFn.isAsync ||
    compiledFn.instructions.some((instr) =>
      INTERPRETER_ONLY_OPS.has(instr.opcode),
    )
  );
}

export function getBinaryOperands(
  frame: BinaryFrameLike,
  operands: RegisterOperand[],
  compiledFn: CompiledFunctionWithFeedback,
): { left: TaggedValue; right: TaggedValue } {
  const left = frame.acc;
  const right = frame.getReg(operands[0] as number);
  const fv = compiledFn.feedbackVector;
  if (fv && !fv.saturated) {
    const slot = fv.getSlot(operands[1] as number);
    if (slot && !slot.isStable) slot.recordBinaryOp(getTag(left), getTag(right));
  }
  return { left, right };
}

export class RegisterException {
  value: TaggedValue;

  constructor(value: TaggedValue) {
    this.value = value;
  }
}

type ResumableGenerator = {
  frame: RegisterFrame;
  state: string;
};

type GeneratorFrameInterpreter = {
  runFrame(frame: RegisterFrame): TaggedValue;
};

/**
 * Run (or resume) a generator's frame to completion or its next suspension,
 * updating the generator's state and returning the appropriate iterator-result.
 * Callers are responsible for the state PRECONDITION checks (and any pending
 * send/throw value setup on gen.frame) before invoking this.
 */
export function runGeneratorFrame(
  interp: GeneratorFrameInterpreter,
  gen: ResumableGenerator,
): TaggedValue {
  gen.state = GEN_EXECUTING;
  try {
    const result = interp.runFrame(gen.frame);
    gen.state = GEN_COMPLETED;
    return createIteratorResult(result, true);
  } catch (e) {
    if (e instanceof GeneratorSuspend) {
      gen.state = GEN_SUSPENDED;
      return createIteratorResult(e.value as TaggedValue, false);
    }
    gen.state = GEN_COMPLETED;
    throw e;
  }
}

export class AsyncSuspend {
  frame: AsyncFrameLike;
  pendingPromise: TaggedValue;

  constructor(frame: AsyncFrameLike, pendingPromise: TaggedValue) {
    this.frame = frame;
    this.pendingPromise = pendingPromise;
  }
}

export function runAsyncWithSuspension(
  interpreter: AsyncInterpreterLike,
  asyncFrame: AsyncFrameLike,
  capability: AsyncCapability,
): void {
  try {
    const result = interpreter.runFrame(asyncFrame);
    capability.resolve(result);
  } catch (e) {
    if (e instanceof AsyncSuspend) {
      const pendingPromise = getPayload(e.pendingPromise) as PromiseLikeRecord;
      const suspendedFrame = e.frame;
      pendingPromise.addReaction((state, result) => {
        if (state === PROMISE_FULFILLED) {
          suspendedFrame.acc = result;
          runAsyncWithSuspension(interpreter, suspendedFrame, capability);
        } else {
          if (suspendedFrame.exceptionHandlers && suspendedFrame.exceptionHandlers.length > 0) {
            const handler = suspendedFrame.exceptionHandlers.pop()!;
            suspendedFrame.acc = result;
            if (handler.catchPC === undefined) {
              capability.reject(result);
              return;
            }
            suspendedFrame.pc = handler.catchPC;
            runAsyncWithSuspension(interpreter, suspendedFrame, capability);
          } else {
            capability.reject(result);
          }
        }
      });
      if (interpreter.microtaskQueue) {
        interpreter.microtaskQueue.drain();
      }
    } else {
      const thrown =
        e === null ||
        e === undefined ||
        typeof e === "object" ||
        typeof e === "string" ||
        typeof e === "number" ||
        typeof e === "boolean" ||
        typeof e === "symbol"
          ? e
          : String(e);
      const errVal = errorToTaggedValue(thrown);
      capability.reject(errVal);
    }
  }
}

export function errorToTaggedValue(
  e: object | string | number | boolean | symbol | null | undefined,
): TaggedValue {
  if (e instanceof RegisterException) return e.value;
  if (e instanceof VMError)
    return vmErrorToTagged(
      e,
      mkString,
      mkObject,
      createJSObject,
      mkBool,
      mkFunction,
    ) as TaggedValue;
  return mkString(String(e instanceof Error ? e.message : e));
}

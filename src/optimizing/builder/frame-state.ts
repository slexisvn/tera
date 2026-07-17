import { FrameState } from "../../deopt/frame-state.js";
import type { FrameValue } from "../../deopt/frame-state.js";

type CompiledFunctionLike = ConstructorParameters<typeof FrameState>[0];

export function captureFrameState(
  compiledFn: CompiledFunctionLike,
  bytecodeOffset: number,
  regs: Map<number, FrameValue> | null | undefined,
  stack: Iterable<FrameValue> | null | undefined,
  frameStates: FrameState[],
): FrameState {
  return captureFrameStateWithCaller(
    compiledFn,
    bytecodeOffset,
    regs,
    stack,
    frameStates,
    null,
  );
}

export function captureFrameStateWithCaller(
  compiledFn: CompiledFunctionLike,
  bytecodeOffset: number,
  regs: Map<number, FrameValue> | null | undefined,
  stack: Iterable<FrameValue> | null | undefined,
  frameStates: FrameState[],
  callerFrameState: FrameState | null | undefined,
): FrameState {
  const fs = new FrameState(compiledFn, bytecodeOffset);

  if (regs instanceof Map) {
    for (const [slot, node] of regs) {
      fs.setLocal(slot, node);
    }
  }

  if (stack) {
    for (const node of stack) {
      fs.pushStack(node);
    }
  }

  if (callerFrameState) {
    fs.setCallerFrame(callerFrameState);
  }

  const id = frameStates.length;
  fs.id = id;
  frameStates.push(fs);

  return fs;
}

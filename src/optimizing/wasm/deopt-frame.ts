import * as ir from "../ir/index.js";
import { RegisterFrame } from "../../bytecode/register/interpreter/index.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import {
  isObject,
  isString,
  mkNumber,
  mkBool,
  mkString,
  mkNull,
  mkUndefined,
  toNumber,
  toBool,
  toDisplayString,
  getPayload,
  typeOf,
  type TaggedValue,
} from "../../core/value/index.js";
import {
  DEOPT_ARRAY_CHECK_FAILED,
  DEOPT_BOUNDS_CHECK_FAILED,
  DEOPT_DIVISION_BY_ZERO,
  DEOPT_ELEMENTS_KIND_CHECK_FAILED,
  DEOPT_GUARD_FAILURE,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_OVERFLOW,
  DEOPT_RUNTIME_STUB_FAILURE,
  DEOPT_SMI_CHECK_FAILED,
  DEOPT_WRONG_CALL_TARGET,
} from "../../deopt/deoptimizer.js";
import { compareValues } from "./runtime-support.js";
import { applyRelational, RELATIONAL_BY_SYMBOL } from "../../runtime/operators.js";
import {
  metadataString as metadataStringOrNull,
  metadataNumber as metadataNumberOrNull,
  metadataNumberArray as metadataNumberArrayOrNull,
} from "../ir/metadata.js";

const DEOPT_REASON_LIST = [
  DEOPT_GUARD_FAILURE,
  DEOPT_SMI_CHECK_FAILED,
  DEOPT_NUMBER_CHECK_FAILED,
  DEOPT_MAP_CHECK_FAILED,
  DEOPT_ARRAY_CHECK_FAILED,
  DEOPT_ELEMENTS_KIND_CHECK_FAILED,
  DEOPT_BOUNDS_CHECK_FAILED,
  DEOPT_OVERFLOW,
  DEOPT_DIVISION_BY_ZERO,
  DEOPT_WRONG_CALL_TARGET,
  DEOPT_RUNTIME_STUB_FAILURE,
];

type DeoptReason = (typeof DEOPT_REASON_LIST)[number];

type DeoptIRNode = ir.CFGInstruction;

interface FrameStateLike {
  compiledFunction: RegisterCompiledFunction | null;
  bytecodeOffset: number;
  stackValues?: FrameValue[];
  thisValue?: FrameValue | null;
  callerFrameState?: FrameStateLike | null;
  hasLocal(slot: number): boolean;
  getLocal(slot: number): FrameValue | undefined;
}

interface InterpreterLike {
  globalCells?: {
    read(name: string): TaggedValue | undefined;
  };
  resumeAt(frame: RegisterFrame): TaggedValue;
}

const DEOPT_REASON_IDS = new Map<DeoptReason, number>(
  DEOPT_REASON_LIST.map((reason, id) => [reason, id]),
);

type RelationalInterpreter = Parameters<typeof applyRelational>[3];

function relationalInterpreter(
  interpreter: InterpreterLike | null | undefined,
): RelationalInterpreter | null {
  const candidate = interpreter as RelationalInterpreter | null | undefined;
  return candidate && typeof candidate.callFunctionValue === "function" ? candidate : null;
}

function isDeoptIRNode(value: FrameValue): value is DeoptIRNode {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DeoptIRNode).id !== undefined &&
    (value as DeoptIRNode).type !== undefined
  );
}

function metadataString(value: ir.IRMetadataValue): string {
  return metadataStringOrNull(value) ?? String(value ?? "");
}

function metadataNumber(value: ir.IRMetadataValue, fallback = -1): number {
  return metadataNumberOrNull(value) ?? fallback;
}

function metadataNumberArray(value: ir.IRMetadataValue): number[] {
  return metadataNumberArrayOrNull(value) ?? [];
}

export function deoptReasonId(reason: DeoptReason): number {
  return (
    DEOPT_REASON_IDS.get(reason) ?? DEOPT_REASON_IDS.get(DEOPT_GUARD_FAILURE)!
  );
}

export function deoptReasonFromId(id: number): DeoptReason {
  return DEOPT_REASON_LIST[id] || DEOPT_GUARD_FAILURE;
}

export function deoptReasonForNode(node: DeoptIRNode | null | undefined): DeoptReason {
  if (!node) return DEOPT_GUARD_FAILURE;
  if (node.type === ir.IR_CHECK_SMI) return DEOPT_SMI_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_NUMBER) return DEOPT_NUMBER_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_MAP) return DEOPT_MAP_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_ARRAY) return DEOPT_ARRAY_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_ELEMENTS_KIND)
    return DEOPT_ELEMENTS_KIND_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_BOUNDS) return DEOPT_BOUNDS_CHECK_FAILED;
  if (node.type === ir.IR_CHECK_CALL_TARGET) return DEOPT_WRONG_CALL_TARGET;
  if (node.type === ir.IR_DEOPTIMIZE)
    return metadataString(node.props.reason) || DEOPT_GUARD_FAILURE;
  return DEOPT_GUARD_FAILURE;
}

export function materializeFrameValue(
  value: FrameValue | null | undefined,
  runtimeValues: Map<number, TaggedValue> | null | undefined,
  args: TaggedValue[],
  interpreter: InterpreterLike | null | undefined,
  thisValue: TaggedValue | null | undefined,
): TaggedValue {
  if (value === null || value === undefined) return mkUndefined();
  if (isDeoptIRNode(value)) {
    const captured = runtimeValues ? runtimeValues.get(value.id) : undefined;
    if (captured !== undefined) return captured;
    if (value.type === ir.IR_LOAD_FIELD) {
      const obj = materializeFrameValue(
        value.inputs[0],
        runtimeValues,
        args,
        interpreter,
        thisValue,
      );
      if (isObject(obj)) {
        const fieldValue = getPayload(obj).getPropertyByOffset(
          metadataNumber(value.props.offset),
        );
        return fieldValue !== undefined ? fieldValue : mkUndefined();
      }
      return mkUndefined();
    }
    if (value.type === ir.IR_POLYMORPHIC_LOAD) {
      const obj = materializeFrameValue(
        value.inputs[0],
        runtimeValues,
        args,
        interpreter,
        thisValue,
      );
      if (isObject(obj)) {
        const payload = getPayload(obj);
        const maps = metadataNumberArray(value.props.maps);
        const offsets = metadataNumberArray(value.props.offsets);
        const mapIndex = maps.indexOf(payload.hiddenClass.id);
        if (mapIndex >= 0) {
          const fieldValue = payload.getPropertyByOffset(
            offsets[mapIndex] ?? -1,
          );
          return fieldValue !== undefined ? fieldValue : mkUndefined();
        }
      }
      return mkUndefined();
    }
    if (value.type === ir.IR_GENERIC_GET_PROP) {
      const obj = materializeFrameValue(
        value.inputs[0],
        runtimeValues,
        args,
        interpreter,
        thisValue,
      );
      if (isObject(obj)) {
        const propValue = getPayload(obj).getProperty(metadataString(value.props.propName));
        return propValue !== undefined ? propValue : mkUndefined();
      }
      return mkUndefined();
    }
    switch (value.type) {
      case ir.IR_CHECK_SMI:
      case ir.IR_CHECK_NUMBER:
      case ir.IR_CHECK_MAP:
      case ir.IR_CHECK_ARRAY:
      case ir.IR_CHECK_ELEMENTS_KIND:
      case ir.IR_CHECK_BOUNDS:
      case ir.IR_CHECK_CALL_TARGET:
      case ir.IR_BOX:
      case ir.IR_UNBOX:
      case ir.IR_BLOCK_PARAM:
      case ir.IR_LOAD_LOCAL:
        return materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
    }
    if (value.type === ir.IR_TYPEOF) {
      const input = materializeFrameValue(
        value.inputs[0],
        runtimeValues,
        args,
        interpreter,
        thisValue,
      );
      return mkString(typeOf(input));
    }
    if (value.type === ir.IR_STORE_LOCAL) {
      return materializeFrameValue(
        value.inputs[1],
        runtimeValues,
        args,
        interpreter,
        thisValue,
      );
    }
    if (value.type === ir.IR_PARAMETER) {
      const index = value.props ? metadataNumber(value.props.index) : -1;
      return index >= 0 && index < args.length ? args[index] : mkUndefined();
    }
    if (value.type === ir.IR_LOAD_GLOBAL && value.props && interpreter) {
      const name = typeof value.props.name === "string" ? value.props.name : "";
      const globalValue = interpreter.globalCells?.read(name);
      return globalValue !== undefined ? globalValue : mkUndefined();
    }
    if (value.type === ir.IR_CONSTANT && value.props) {
      if (value.props.isThis) return thisValue == null ? mkUndefined() : thisValue;
      const constant = value.props.value;
      if (typeof constant === "number") return mkNumber(constant);
      if (typeof constant === "string") return mkString(constant);
      if (typeof constant === "boolean") return mkBool(constant);
      if (constant === null) return mkNull();
      if (constant === undefined) return mkUndefined();
    }
    switch (value.type) {
      case ir.IR_INT32_ADD:
      case ir.IR_FLOAT64_ADD:
      case ir.IR_GENERIC_ADD: {
        const left = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        const right = materializeFrameValue(
          value.inputs[1],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        if (isString(left) || isString(right)) {
          return mkString(toDisplayString(left) + toDisplayString(right));
        }
        return mkNumber(toNumber(left) + toNumber(right));
      }
      case ir.IR_INT32_SUB:
      case ir.IR_FLOAT64_SUB:
      case ir.IR_GENERIC_SUB: {
        const left = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        const right = materializeFrameValue(
          value.inputs[1],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        return mkNumber(toNumber(left) - toNumber(right));
      }
      case ir.IR_INT32_MUL:
      case ir.IR_FLOAT64_MUL:
      case ir.IR_GENERIC_MUL: {
        const left = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        const right = materializeFrameValue(
          value.inputs[1],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        return mkNumber(toNumber(left) * toNumber(right));
      }
      case ir.IR_INT32_DIV:
      case ir.IR_FLOAT64_DIV:
      case ir.IR_GENERIC_DIV: {
        const left = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        const right = materializeFrameValue(
          value.inputs[1],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        return mkNumber(toNumber(left) / toNumber(right));
      }
      case ir.IR_INT32_MOD:
      case ir.IR_GENERIC_MOD: {
        const left = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        const right = materializeFrameValue(
          value.inputs[1],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        return mkNumber(toNumber(left) % toNumber(right));
      }
      case ir.IR_INT32_COMPARE:
      case ir.IR_FLOAT64_COMPARE:
      case ir.IR_GENERIC_COMPARE: {
        const left = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        const right = materializeFrameValue(
          value.inputs[1],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        const symbol = metadataString(value.props.op);
        const relational = RELATIONAL_BY_SYMBOL[symbol];
        const caller = relationalInterpreter(interpreter);
        if (relational && caller) return applyRelational(relational, left, right, caller);
        return mkBool(compareValues(symbol, left, right));
      }
      case ir.IR_NEG: {
        const input = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        return mkNumber(-toNumber(input));
      }
      case ir.IR_NOT: {
        const input = materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
        return mkBool(!toBool(input));
      }
    }
    return mkUndefined();
}
    return typeof value === "number" ? value as TaggedValue : mkUndefined();
}

function requireCompiledFunction(
  compiledFunction: RegisterCompiledFunction | null,
): RegisterCompiledFunction {
  if (!compiledFunction) {
    throw new Error("Frame state is missing compiled function");
  }
  return compiledFunction;
}

export function materializeFrameFromState(
  compiledFn: RegisterCompiledFunction,
  args: TaggedValue[],
  thisValue: TaggedValue | undefined,
  frameState: FrameStateLike | null | undefined,
  runtimeValues: Map<number, TaggedValue> | null | undefined,
  interpreter: InterpreterLike | null | undefined,
): RegisterFrame {
  const frame = new RegisterFrame(
    compiledFn,
    args,
    thisValue === undefined ? mkUndefined() : thisValue,
  );
  if (!frameState) return frame;
  const localsCount = frame.locals.length;
  for (let i = 0; i < localsCount; i++) {
    if (frameState.hasLocal(i)) {
      frame.locals[i] = materializeFrameValue(
        frameState.getLocal(i),
        runtimeValues,
        args,
        interpreter,
        thisValue,
      );
    }
  }
  if (frameState.stackValues && frameState.stackValues.length > 0) {
    frame.acc = materializeFrameValue(
      frameState.stackValues[frameState.stackValues.length - 1],
      runtimeValues,
      args,
      interpreter,
      thisValue,
    );
  }
  if (frameState.thisValue !== null) {
    frame.thisValue = materializeFrameValue(
      frameState.thisValue,
      runtimeValues,
      args,
      interpreter,
      thisValue,
    );
  }
  frame.pc = frameState.bytecodeOffset;
  return frame;
}

export function resumeFrameStateChain(
  args: TaggedValue[],
  thisValue: TaggedValue | undefined,
  frameState: FrameState,
  runtimeValues: Map<number, TaggedValue> | null | undefined,
  interpreter: InterpreterLike,
): TaggedValue {
  let currentFrameState = frameState;
  let currentFrame = materializeFrameFromState(
    requireCompiledFunction(currentFrameState.compiledFunction),
    args,
    thisValue,
    currentFrameState,
    runtimeValues,
    interpreter,
  );
  let finalResult = interpreter.resumeAt(currentFrame);

  while (currentFrameState.callerFrameState) {
    currentFrameState = currentFrameState.callerFrameState;
    const callerFrame = materializeFrameFromState(
      requireCompiledFunction(currentFrameState.compiledFunction),
      args,
      thisValue,
      currentFrameState,
      runtimeValues,
      interpreter,
    );
    callerFrame.acc = finalResult;
    finalResult = interpreter.resumeAt(callerFrame);
  }

  return finalResult;
}

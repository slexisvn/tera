import * as ir from "../optimizing/ir/index.js";
import { RegisterFrame } from "../bytecode/register/interpreter/index.js";
import type { FrameState, FrameValue } from "./frame-state.js";
import { withMaterializedAllocations } from "./materializer.js";
import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";
import type { Environment } from "../runtime/intrinsics/environment.js";
import {
  isObject,
  isString,
  mkNumber,
  mkBool,
  mkString,
  mkNull,
  mkUndefined,
  mkFunction,
  JSFunction,
  toNumber,
  toBool,
  toDisplayString,
  getPayload,
  typeOf,
  type TaggedValue,
} from "../core/value/index.js";
import { compiledFunctionConstant } from "../optimizing/ir/compiled-function.js";
import { compareValues, getRuntimeProperty } from "../runtime/value-semantics.js";
import { applyRelational, RELATIONAL_BY_SYMBOL } from "../runtime/operators.js";
import {
  metadataString as metadataStringOrNull,
  metadataNumber as metadataNumberOrNull,
  metadataNumberArray as metadataNumberArrayOrNull,
} from "../optimizing/ir/metadata.js";

type DeoptIRNode = ir.CFGInstruction;

export interface FrameStateLike {
  compiledFunction: RegisterCompiledFunction | null;
  bytecodeOffset: number;
  stackValues?: FrameValue[];
  thisValue?: FrameValue | null;
  sunkAllocations?: FrameState["sunkAllocations"];
  callerFrameState?: FrameStateLike | null;
  hasLocal(slot: number): boolean;
  getLocal(slot: number): FrameValue | undefined;
}

export interface InterpreterLike {
  globalCells?: {
    read(name: string): TaggedValue | undefined;
  };
  resumeAt(frame: RegisterFrame): TaggedValue;
}

type RelationalInterpreter = Parameters<typeof applyRelational>[3];

function relationalInterpreter(
  interpreter: InterpreterLike | null | undefined,
): RelationalInterpreter | null {
  const candidate = interpreter as RelationalInterpreter | null | undefined;
  return candidate && typeof candidate.callFunctionValue === "function" ? candidate : null;
}

type PropertyInterpreter = NonNullable<Parameters<typeof getRuntimeProperty>[2]>;

function propertyInterpreter(
  interpreter: InterpreterLike | null | undefined,
): PropertyInterpreter | null {
  const candidate = interpreter as PropertyInterpreter | null | undefined;
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
    if (value.type === ir.IR_PARAMETER) {
      const index = value.props ? metadataNumber(value.props.index) : -1;
      return index >= 0 && index < args.length ? args[index] : mkUndefined();
    }
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
      return getRuntimeProperty(
        obj,
        metadataString(value.props.propName),
        propertyInterpreter(interpreter),
      );
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
      case ir.IR_LOAD_LOCAL:
      case ir.IR_STORE_CONTEXT_SLOT:
        return materializeFrameValue(
          value.inputs[0],
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
    }
    if (value.type === ir.IR_PHI) {
      const input = ir.trivialPhiInput(value);
      if (input) {
        return materializeFrameValue(
          input,
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
      }
      throw new Error(ir.missingPhiRuntimeValueMessage(value));
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
    if (value.type === ir.IR_GENERIC_DELETE_PROP) {
      return mkBool(true);
    }
    if (
      value.type === ir.IR_LOAD_CONTEXT_SLOT ||
      value.type === ir.IR_MAKE_CLOSURE
    ) {
      throw new Error(`Cannot materialize ${value.type} v${value.id} without runtime value`);
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
      const compiled = compiledFunctionConstant(constant);
      if (compiled)
        return mkFunction(new JSFunction(compiled, compiled.name ?? undefined));
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
  closureEnv: Environment | null,
): RegisterFrame {
  const frame = new RegisterFrame(
    compiledFn,
    args,
    thisValue === undefined ? mkUndefined() : thisValue,
    closureEnv,
  );
  if (!frameState) return frame;
  const resolved = withMaterializedAllocations(frameState, runtimeValues);
  const localsCount = frame.locals.length;
  for (let i = 0; i < localsCount; i++) {
    if (frameState.hasLocal(i)) {
      frame.locals[i] = materializeFrameValue(
        frameState.getLocal(i),
        resolved,
        args,
        interpreter,
        thisValue,
      );
    }
  }
  if (frameState.stackValues && frameState.stackValues.length > 0) {
    frame.acc = materializeFrameValue(
      frameState.stackValues[frameState.stackValues.length - 1],
      resolved,
      args,
      interpreter,
      thisValue,
    );
  }
  if (frameState.thisValue !== null) {
    frame.thisValue = materializeFrameValue(
      frameState.thisValue,
      resolved,
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
  closureEnv: Environment | null,
): TaggedValue {
  let currentFrameState = frameState;
  let currentFrame = materializeFrameFromState(
    requireCompiledFunction(currentFrameState.compiledFunction),
    args,
    thisValue,
    currentFrameState,
    runtimeValues,
    interpreter,
    closureEnv,
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
      closureEnv,
    );
    callerFrame.acc = finalResult;
    finalResult = interpreter.resumeAt(callerFrame);
  }

  return finalResult;
}

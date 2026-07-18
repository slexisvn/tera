import { VMTypeError } from "../core/errors/index.js";
import { CODE_OBJECT, codeOf, isFunction, type TaggedValue } from "../core/value/index.js";
import { runtimeGetProperty, type InterpreterLike } from "../objects/exotic/proxy-ops.js";

export type NumericOperator = "add" | "sub" | "mul" | "div" | "pow";
export type BinaryOverload = NumericOperator | "matmul";
export type UnaryOverload = "neg";

const OPERATOR_SYMBOL: Record<BinaryOverload | UnaryOverload, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  pow: "**",
  matmul: "@",
  neg: "-",
};

const COMMUTATIVE: ReadonlySet<BinaryOverload> = new Set<BinaryOverload>(["add", "mul"]);

const NUMERIC_FALLBACK: ReadonlySet<BinaryOverload> = new Set<NumericOperator>([
  "add", "sub", "mul", "div", "pow",
]);

function overloadOf(
  value: TaggedValue,
  method: BinaryOverload | UnaryOverload,
  interpreter: InterpreterLike,
): TaggedValue | null {
  if (codeOf(value) !== CODE_OBJECT) return null;
  const candidate = runtimeGetProperty(value, method, interpreter);
  return isFunction(candidate) ? candidate : null;
}

function unsupported(method: BinaryOverload | UnaryOverload): never {
  throw new VMTypeError(`operator '${OPERATOR_SYMBOL[method]}' requires a left operand with ${method}()`);
}

export function applyBinaryOverload(
  method: Exclude<BinaryOverload, NumericOperator>,
  left: TaggedValue,
  right: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue;
export function applyBinaryOverload(
  method: BinaryOverload,
  left: TaggedValue,
  right: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue | null;
export function applyBinaryOverload(
  method: BinaryOverload,
  left: TaggedValue,
  right: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue | null {
  const onLeft = overloadOf(left, method, interpreter);
  if (onLeft) return interpreter.callFunctionValue(onLeft, [right], left);

  const onRight = overloadOf(right, method, interpreter);
  if (onRight && COMMUTATIVE.has(method)) {
    return interpreter.callFunctionValue(onRight, [left], right);
  }
  if (onRight || !NUMERIC_FALLBACK.has(method)) unsupported(method);
  return null;
}

export function applyUnaryOverload(
  method: UnaryOverload,
  operand: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue | null {
  const overload = overloadOf(operand, method, interpreter);
  return overload ? interpreter.callFunctionValue(overload, [], operand) : null;
}

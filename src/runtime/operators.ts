import { VMTypeError } from "../core/errors/index.js";
import { abstractRelational, CODE_OBJECT, codeOf, isFunction, mkBool, type TaggedValue } from "../core/value/index.js";
import { runtimeGetProperty, type InterpreterLike } from "../objects/exotic/proxy-ops.js";

export type NumericOperator = "add" | "sub" | "mul" | "div" | "pow";
export type BinaryOverload = NumericOperator | "matmul";
export type UnaryOverload = "neg";
export type RelationalOverload = "lt" | "le" | "gt" | "ge";

const OPERATOR_SYMBOL: Record<BinaryOverload | UnaryOverload, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  pow: "**",
  matmul: "@",
  neg: "-",
};

const REFLECTED: Record<RelationalOverload, RelationalOverload> = {
  lt: "gt",
  gt: "lt",
  le: "ge",
  ge: "le",
};

const RELATIONAL_TEST: Record<RelationalOverload, (order: number) => boolean> = {
  lt: (order) => order < 0,
  gt: (order) => order > 0,
  le: (order) => order <= 0,
  ge: (order) => order >= 0,
};

const COMMUTATIVE: ReadonlySet<BinaryOverload> = new Set<BinaryOverload>(["add", "mul"]);

const NUMERIC_FALLBACK: ReadonlySet<BinaryOverload> = new Set<NumericOperator>([
  "add", "sub", "mul", "div", "pow",
]);

function overloadOf(
  value: TaggedValue,
  method: BinaryOverload | UnaryOverload | RelationalOverload,
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

export function hasRelationalOverload(
  method: RelationalOverload,
  left: TaggedValue,
  right: TaggedValue,
  interpreter: InterpreterLike,
): boolean {
  return overloadOf(left, method, interpreter) !== null
    || overloadOf(right, REFLECTED[method], interpreter) !== null;
}

export const RELATIONAL_BY_SYMBOL: Record<string, RelationalOverload | undefined> = {
  "<": "lt",
  ">": "gt",
  "<=": "le",
  ">=": "ge",
};

export function applyRelational(
  method: RelationalOverload,
  left: TaggedValue,
  right: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue {
  const onLeft = overloadOf(left, method, interpreter);
  if (onLeft) return interpreter.callFunctionValue(onLeft, [right], left);

  const onRight = overloadOf(right, REFLECTED[method], interpreter);
  if (onRight) return interpreter.callFunctionValue(onRight, [left], right);

  return mkBool(RELATIONAL_TEST[method](abstractRelational(left, right)));
}

export function applyUnaryOverload(
  method: UnaryOverload,
  operand: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue | null {
  const overload = overloadOf(operand, method, interpreter);
  return overload ? interpreter.callFunctionValue(overload, [], operand) : null;
}

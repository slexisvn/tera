import { compatible, resolveType, unionParts, type TypeEnv, type TypeName } from "./type-system.js";

export type BinaryOperatorSemantics = {
  result: TypeName;
  valid: boolean;
};

const EQUALITY_OPERATORS = new Set(["==", "!=", "===", "!=="]);
const ORDERED_OPERATORS = new Set(["<", "<=", ">", ">="]);
const NUMERIC_OPERATORS = new Set(["+", "-", "*", "/", "%", "**"]);
const BITWISE_OPERATORS = new Set(["&", "|", "^", "<<", ">>", ">>>"]);
const TENSOR_OPERATORS = new Set(["+", "-", "*", "/", "**"]);
const TENSOR_REFLECTED_OPERATORS = new Set(["+", "*"]);

export function binaryOperatorSemantics(op: string, left: TypeName, right: TypeName, env: TypeEnv): BinaryOperatorSemantics {
  if (EQUALITY_OPERATORS.has(op)) return { result: "bool", valid: acceptsEquality(left, right, env) };
  if (ORDERED_OPERATORS.has(op)) return { result: "bool", valid: acceptsOrderedComparison(left, right, env) };
  if (op === "in" || op === "instanceof") return { result: "bool", valid: true };
  if (op === "@") {
    const valid = isTensorType(left, env) && isTensorType(right, env);
    return { result: valid ? "Tensor" : "any", valid };
  }
  if (op === "+" && (isStringType(left, env) || isStringType(right, env)) && !isTensorType(left, env) && !isTensorType(right, env)) {
    return { result: "string", valid: true };
  }
  if (resolveType(left, env) === "any" || resolveType(right, env) === "any") return { result: "any", valid: true };
  if (tensorArithmeticResult(op, left, right, env)) return { result: "Tensor", valid: true };
  if (BITWISE_OPERATORS.has(op)) return { result: "int", valid: isNumericScalar(left, env) && isNumericScalar(right, env) };
  if (NUMERIC_OPERATORS.has(op) && compatible(left, "float", env) && compatible(right, "float", env)) {
    return { result: left === "int" && right === "int" && op !== "/" ? "int" : "float", valid: true };
  }
  return { result: "any", valid: false };
}

export function isTensorType(type: TypeName, env: TypeEnv): boolean {
  return resolveType(type, env) === "Tensor";
}

function isStringType(type: TypeName, env: TypeEnv): boolean {
  return compatible(type, "string", env);
}

export function acceptsTensorLeftArithmetic(op: string, right: TypeName, env: TypeEnv): boolean {
  return TENSOR_OPERATORS.has(op) && (isTensorType(right, env) || isNumericScalar(right, env));
}

export function acceptsTensorRightArithmetic(op: string, left: TypeName, env: TypeEnv): boolean {
  return TENSOR_REFLECTED_OPERATORS.has(op) && isNumericScalar(left, env);
}

function tensorArithmeticResult(op: string, left: TypeName, right: TypeName, env: TypeEnv): TypeName | null {
  if (!TENSOR_OPERATORS.has(op)) return null;
  if (isTensorType(left, env) && acceptsTensorLeftArithmetic(op, right, env)) return "Tensor";
  if (isTensorType(right, env) && acceptsTensorRightArithmetic(op, left, env)) return "Tensor";
  return null;
}

function isNumericScalar(type: TypeName, env: TypeEnv): boolean {
  return compatible(type, "float", env) && !isTensorType(type, env);
}

function acceptsOrderedComparison(left: TypeName, right: TypeName, env: TypeEnv): boolean {
  return (compatible(left, "float", env) && compatible(right, "float", env)) ||
    (compatible(left, "string", env) && compatible(right, "string", env));
}

function acceptsEquality(left: TypeName, right: TypeName, env: TypeEnv): boolean {
  for (const leftPart of unionParts(left, env)) {
    for (const rightPart of unionParts(right, env)) {
      if (isNullish(leftPart) && isNullish(rightPart)) return true;
      if (compatible(leftPart, rightPart, env) || compatible(rightPart, leftPart, env)) return true;
    }
  }
  return false;
}

function isNullish(type: TypeName): boolean {
  return type === "null" || type === "undefined";
}

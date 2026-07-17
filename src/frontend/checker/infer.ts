import { NodeType, type ASTNode, type ObjectPropertyNode } from "../ast/index.js";
import { lookup, type BoundProgram, type Scope } from "./binder.js";
import {
  cleanType,
  compatible,
  instantiateShapeForType,
  instantiateSignature,
  parseFunctionType,
  removeNullish,
  resolveType,
  splitTopLevel,
  substituteType,
  unionParts,
  unionType,
  type Binding,
  type ObjectShape,
  type Signature,
  type TypeEnv,
  type TypeName,
} from "./type-system.js";

export function inferExpression(node: ASTNode | undefined, bound: BoundProgram, scope: Scope, expected?: Signature | null): TypeName {
  if (!node) return "undefined";
  switch (node.type) {
    case NodeType.Literal:
      return literalType(node);
    case NodeType.Identifier:
      return lookup(scope, String(node.name))?.type ?? "any";
    case NodeType.ArrayExpression:
      return inferArray(node, bound, scope);
    case NodeType.ObjectExpression:
      return "Object";
    case NodeType.BinaryExpression:
    case NodeType.LogicalExpression:
    case NodeType.NullishCoalescingExpression:
      return inferBinary(node, bound, scope);
    case NodeType.MemberExpression:
    case NodeType.OptionalMemberExpression:
      return inferMember(node, bound, scope);
    case NodeType.CallExpression:
    case NodeType.OptionalCallExpression:
      return inferCall(node, bound, scope);
    case NodeType.ArrowFunctionExpression:
      return inferArrow(node, bound, scope, expected ?? null);
    case NodeType.ConditionalExpression: {
      const a = inferExpression(node.consequent as ASTNode, bound, scope);
      const b = inferExpression(node.alternate as ASTNode, bound, scope);
      return a === b ? a : unionType([a, b]);
    }
    default:
      return "any";
  }
}

function literalType(node: ASTNode): TypeName {
  if (node.kind === "number") return Number.isInteger(node.value) ? "int" : "float";
  if (node.kind === "string") return "string";
  if (node.kind === "boolean") return "bool";
  if (node.kind === "null") return "null";
  return node.value === undefined ? "undefined" : "any";
}

function inferArray(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const elements = (node.elements as Array<ASTNode | null>).filter((item): item is ASTNode => !!item);
  if (!elements.length) return "unknown[]";
  return `[${elements.map((item) => inferExpression(item, bound, scope)).join(", ")}]`;
}

function inferBinary(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const op = String(node.op ?? "");
  const left = inferExpression(node.left as ASTNode, bound, scope);
  const right = inferExpression(node.right as ASTNode, bound, scope);
  if (op === "+" && (left === "string" || right === "string")) return "string";
  if (["+", "-", "*", "/", "%"].includes(op) && compatible(left, "number", bound.env) && compatible(right, "number", bound.env)) return "number";
  if (["==", "!=", "===", "!==", "<", "<=", ">", ">="].includes(op)) return "bool";
  if (op === "@" && left === "Tensor") return "Tensor";
  if (node.type === NodeType.NullishCoalescingExpression) return unionType([removeNullish(left, bound.env), right]);
  return "any";
}

export function objectLiteralShape(node: ASTNode, bound: BoundProgram, scope: Scope): ObjectShape {
  const fields = new Map<string, Binding>();
  for (const prop of node.properties as ObjectPropertyNode[]) {
    if (prop.spread || prop.computed || prop.key === undefined) continue;
    const name = typeof prop.key === "string" ? prop.key : String((prop.key as ASTNode).value ?? "");
    if (!name) continue;
    fields.set(name, { type: inferExpression(prop.value, bound, scope), optional: false });
  }
  return { fields };
}

function inferMember(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const objectType = resolveType(inferExpression(node.object as ASTNode, bound, scope), bound.env);
  const property = typeof node.property === "string" ? node.property : String((node.property as ASTNode).name ?? "");
  const shape = instantiateShapeForType(objectType, bound.env);
  const field = shape?.fields.get(property);
  if (field) return field.type;
  if (objectType === "string" && property === "length") return "number";
  if ((objectType.endsWith("[]") || objectType.startsWith("[")) && property === "length") return "number";
  return "any";
}

function callName(callee: ASTNode): string | null {
  if (callee.type === NodeType.Identifier) return String(callee.name);
  if (callee.type === NodeType.MemberExpression) {
    const object = callName(callee.object as ASTNode);
    const property = typeof callee.property === "string" ? callee.property : String((callee.property as ASTNode).name ?? "");
    return object ? `${object}.${property}` : property;
  }
  return null;
}

export function instantiateForCall(sig: Signature, args: ASTNode[], bound: BoundProgram, scope: Scope): Signature {
  if (sig.typeParams.length === 0) return sig;
  const substitutions = new Map<string, TypeName>();
  let positional = 0;
  for (const rawArg of args) {
    const isNamed = rawArg.type === NodeType.NamedArgument;
    const paramName = isNamed ? String(rawArg.name) : sig.positional[positional++];
    if (!paramName) continue;
    const param = sig.params.get(paramName);
    if (!param) continue;
    const value = isNamed ? rawArg.value as ASTNode : rawArg;
    const actual = inferExpression(value, bound, scope);
    for (const typeParam of sig.typeParams) {
      if (!substitutions.has(typeParam) && new RegExp(`\\b${typeParam}\\b`).test(param.type)) {
        substitutions.set(typeParam, actual);
      }
    }
  }
  return instantiateSignature(sig, substitutions);
}

function inferCall(node: ASTNode, bound: BoundProgram, scope: Scope): TypeName {
  const name = callName(node.callee as ASTNode);
  if (!name) return "any";
  const sig = bound.signatures.get(name);
  if (!sig) return methodReturn(name);
  return instantiateForCall(sig, node.args as ASTNode[], bound, scope).returns;
}

function methodReturn(name: string): TypeName {
  const method = name.split(".").at(-1);
  if (method === "parameters") return "Array";
  if (method === "is_training") return "bool";
  if (method === "validate" || method === "forward") return "Tensor";
  if (method === "optimizer") return "Object";
  if (method === "count") return "number";
  if (method === "columns" || method === "collect" || method === "toArray") return "Array";
  if (method === "toString" || method === "to_string") return "string";
  if (method === "relu" || method === "mean" || method === "matmul") return "Tensor";
  return "any";
}

function inferArrow(node: ASTNode, bound: BoundProgram, scope: Scope, expected: Signature | null): TypeName {
  const child: Scope = { parent: scope, locals: new Map(), signature: expected ?? undefined };
  const params = node.params as Array<string | { name?: string }>;
  for (let i = 0; i < params.length; i++) {
    const paramName = typeof params[i] === "string" ? params[i] as string : String((params[i] as { name?: string }).name ?? `arg${i}`);
    const expectedType = expected?.params.get(expected.positional[i])?.type ?? "any";
    child.locals.set(paramName, { type: expectedType, optional: false });
  }
  const body = node.body as ASTNode | ASTNode[];
  const returnType = Array.isArray(body) ? "any" : inferExpression(body, bound, child);
  const paramTypes = params.map((_, i) => expected?.params.get(expected.positional[i])?.type ?? "any").join(", ");
  return `(${paramTypes}) -> ${returnType}`;
}

export function narrowScope(test: ASTNode | undefined, bound: BoundProgram, parent: Scope): Scope {
  const child: Scope = { parent, locals: new Map(), signature: parent.signature };
  if (!test) return child;
  if (test.type === NodeType.BinaryExpression && (test.op === "!=" || test.op === "==")) {
    const left = test.left as ASTNode;
    const right = test.right as ASTNode;
    if (left.type === NodeType.Identifier && right.type === NodeType.Literal && right.kind === "null") {
      const binding = lookup(parent, String(left.name));
      if (binding) {
        const next = test.op === "!=" ? removeNullish(binding.type, bound.env) : unionType(unionParts(binding.type, bound.env).filter((part) => part === "null" || part === "undefined"));
        child.locals.set(String(left.name), { ...binding, type: next });
      }
    }
  }
  return child;
}

export function functionSignatureForType(name: string, type: TypeName): Signature | null {
  const parsed = parseFunctionType(type);
  return parsed ? { ...parsed, name } : null;
}

import { astChildren, NodeType, type ASTNode } from "../../frontend/ast/index.js";
import {
  everyCollection,
  type CollectionRequest,
  type KeyKind,
  type ValueKind,
} from "./collections.js";

const KEYED_MEMBERS: ReadonlySet<string> = new Set(["set", "get", "has", "delete", "add"]);
const MAP_MEMBERS: ReadonlySet<string> = new Set(["set", "get"]);
const PRIMITIVE_KEYS: readonly KeyKind[] = ["string", "int", "float"];
const PRIMITIVE_VALUES: readonly ValueKind[] = ["int", "float", "string"];
const DECLARATIONS: ReadonlySet<string> = new Set([
  NodeType.LetDeclaration,
  NodeType.ConstDeclaration,
  NodeType.VarDeclaration,
]);

interface Observed {
  readonly keys: Set<KeyKind>;
  readonly values: Set<ValueKind>;
  wantsMap: boolean;
  wantsSet: boolean;
  unknownKey: boolean;
  unknownValue: boolean;
}

function classNames(node: ASTNode, found: Set<string> = new Set()): Set<string> {
  if (node.type === NodeType.ClassDeclaration && typeof node.name === "string") {
    found.add(node.name);
  }
  for (const child of astChildren(node)) classNames(child, found);
  return found;
}

function literalKey(node: ASTNode): KeyKind | null {
  if (node.type !== NodeType.Literal) return null;
  if (node.kind === "string") return "string";
  if (node.kind !== "number") return null;
  return Number.isInteger(node.value) && !/[.eE]/.test(String(node.__raw ?? "")) ? "int" : "float";
}

function declaredName(node: ASTNode): string | null {
  const declared = node.declaredType;
  return typeof declared === "string" ? declared : null;
}

function boundClasses(
  node: ASTNode,
  classes: ReadonlySet<string>,
  bound: Map<string, string> = new Map(),
): Map<string, string> {
  const remember = (name: unknown, named: string | null): void => {
    if (typeof name === "string" && named !== null && classes.has(named)) bound.set(name, named);
  };
  if (node.type === NodeType.AssignmentExpression) {
    const target = node.target as ASTNode | undefined;
    const value = node.value as ASTNode | undefined;
    if (target?.type === NodeType.Identifier && value !== undefined) {
      remember(target.name, constructedClass(value, classes));
    }
  }
  if (DECLARATIONS.has(node.type)) {
    const init = node.init as ASTNode | undefined;
    remember(node.name, declaredName(node) ?? (init && constructedClass(init, classes)) ?? null);
  }
  for (const param of parameterInfoOf(node)) remember(param.name, param.type ?? null);
  for (const child of astChildren(node)) boundClasses(child, classes, bound);
  return bound;
}

function parameterInfoOf(node: ASTNode): readonly { name?: string; type?: string }[] {
  const declared = node._paramInfo;
  return Array.isArray(declared) ? (declared as { name?: string; type?: string }[]) : [];
}

function constructedClass(node: ASTNode, classes: ReadonlySet<string>): string | null {
  const callee =
    node.type === NodeType.NewExpression || node.type === NodeType.CallExpression
      ? (node.callee as ASTNode | undefined)
      : undefined;
  if (callee === undefined || callee.type !== NodeType.Identifier) return null;
  const name = String(callee.name);
  return classes.has(name) ? name : null;
}

function memberCalled(node: ASTNode): { member: string; args: ASTNode[] } | null {
  if (node.type !== NodeType.CallExpression) return null;
  const callee = node.callee as ASTNode | undefined;
  if (callee === undefined || callee.type !== NodeType.MemberExpression || callee.computed) {
    return null;
  }
  const member = String(callee.property);
  return KEYED_MEMBERS.has(member) ? { member, args: (node.args as ASTNode[]) ?? [] } : null;
}

function heldClass(
  node: ASTNode,
  classes: ReadonlySet<string>,
  bound: ReadonlyMap<string, string>,
): string | null {
  if (node.type === NodeType.Identifier) return bound.get(String(node.name)) ?? null;
  return constructedClass(node, classes);
}

function observe(
  node: ASTNode,
  classes: ReadonlySet<string>,
  bound: ReadonlyMap<string, string>,
  seen: Observed,
): void {
  const call = memberCalled(node);
  if (call !== null) {
    if (call.member === "add") seen.wantsSet = true;
    if (MAP_MEMBERS.has(call.member)) seen.wantsMap = true;
    const key = call.args[0] === undefined ? null : literalKey(call.args[0]);
    if (key === null) seen.unknownKey = true;
    else seen.keys.add(key);
    if (call.member === "set") {
      const stored = call.args[1];
      const named = stored === undefined ? null : heldClass(stored, classes, bound);
      const primitive = stored === undefined ? null : literalKey(stored);
      if (named !== null) seen.values.add(named);
      else if (primitive !== null) seen.values.add(primitive);
      else seen.unknownValue = true;
    }
  }
  for (const child of astChildren(node)) observe(child, classes, bound, seen);
}

export function collectionRequestsIn(program: ASTNode): readonly CollectionRequest[] {
  return collectionRequestsAcross([program]);
}

export function collectionRequestsAcross(
  roots: readonly ASTNode[],
  nameable: ReadonlySet<string> | null = null,
): readonly CollectionRequest[] {
  const seen: Observed = {
    keys: new Set(),
    values: new Set(),
    wantsMap: false,
    wantsSet: false,
    unknownKey: false,
    unknownValue: false,
  };
  const classes = new Set<string>();
  for (const root of roots) classNames(root, classes);
  const bound = new Map<string, string>();
  for (const root of roots) boundClasses(root, classes, bound);
  for (const root of roots) observe(root, classes, bound, seen);
  if (!seen.wantsMap && !seen.wantsSet) return everyCollection();
  for (const value of [...seen.values]) {
    if (!classes.has(value) || nameable === null || nameable.has(value)) continue;
    seen.values.delete(value);
    seen.unknownValue = true;
  }

  const keys = seen.unknownKey ? PRIMITIVE_KEYS : [...seen.keys];
  const values = seen.unknownValue ? [...seen.values, ...PRIMITIVE_VALUES] : [...seen.values];
  if (keys.length === 0) return everyCollection();

  const requested: CollectionRequest[] = [];
  for (const key of keys) {
    if (seen.wantsSet) requested.push({ kind: "Set", key, value: null });
    if (!seen.wantsMap) continue;
    const held = values.length === 0 ? PRIMITIVE_VALUES : values;
    for (const value of held) requested.push({ kind: "Map", key, value });
  }
  return requested;
}

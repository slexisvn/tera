import type { SemanticNode, SemanticProgram } from "./semantic-ast.js";
import {
  BUILTIN_SIGNATURES,
  cleanType,
  createTypeEnv,
  instantiateShapeForType,
  parseFunctionType,
  type Binding,
  type ObjectShape,
  type Signature,
  type TypeEnv,
} from "./type-system.js";

export type Scope = {
  parent: Scope | null;
  locals: Map<string, Binding>;
  signature?: Signature;
};

export type BoundProgram = {
  program: SemanticProgram;
  env: TypeEnv;
  signatures: Map<string, Signature>;
  root: Scope;
  scopes: WeakMap<SemanticNode, Scope>;
};

function signatureFromParams(name: string, typeParams: string[], params: Array<{ name: string; type: string; optional: boolean }>, returns: string): Signature {
  const paramMap = new Map<string, Binding>();
  const required = new Set<string>();
  const positional: string[] = [];
  for (const param of params) {
    paramMap.set(param.name, { type: cleanType(param.type), optional: param.optional });
    positional.push(param.name);
    if (!param.optional) required.add(param.name);
  }
  return { name, typeParams, params: paramMap, required, positional, returns: cleanType(returns) };
}

function bindNode(node: SemanticNode, bound: BoundProgram, scope: Scope): void {
  if (node.kind === "TypeAlias") {
    bound.env.aliases.set(node.name, { typeParams: node.typeParams, type: cleanType(node.type) });
    return;
  }
  if (node.kind === "Interface") {
    const shape: ObjectShape = { typeParams: node.typeParams, fields: new Map() };
    for (const parent of node.parents) {
      const parentShape = instantiateShapeForType(parent, bound.env);
      if (!parentShape) continue;
      for (const [name, binding] of parentShape.fields) shape.fields.set(name, binding);
    }
    for (const field of node.fields) {
      shape.fields.set(field.name, { type: cleanType(field.type), optional: field.optional });
    }
    bound.env.interfaces.set(node.name, shape);
    return;
  }
  if (node.kind === "Function") {
    const sig = signatureFromParams(node.name, node.typeParams, node.params, node.returns);
    bound.signatures.set(node.name, sig);
    const child = createScope(scope, sig);
    bound.scopes.set(node, child);
    for (const [name, binding] of sig.params) child.locals.set(name, binding);
    for (const stmt of node.body) bindNode(stmt, bound, child);
    return;
  }
  if (node.kind === "Model") {
    const sig = signatureFromParams(node.name, [], node.params, node.name);
    bound.signatures.set(node.name, sig);
    const child = createScope(scope, sig);
    bound.scopes.set(node, child);
    for (const [name, binding] of sig.params) child.locals.set(name, binding);
    const section = createScope(child, signatureFromParams(node.name, [], [], "any"));
    for (const stmt of node.body) bindNode(stmt, bound, isModelSection(stmt) ? section : child);
    return;
  }
  if (node.kind === "Block") {
    const child = createScope(scope, scope.signature);
    bound.scopes.set(node, child);
    for (const stmt of node.body) bindNode(stmt, bound, child);
    return;
  }
  if (node.kind === "Var") {
    const type = cleanType(node.declaredType) || "any";
    scope.locals.set(node.name, { type, optional: false });
    const callable = parseFunctionType(type);
    if (callable) bound.signatures.set(node.name, { ...callable, name: node.name });
  }
}

function isModelSection(node: SemanticNode): boolean {
  return node.kind === "Block" && node.test === undefined;
}

function createScope(parent: Scope | null, signature?: Signature): Scope {
  return { parent, locals: new Map(), signature };
}

export function bindProgram(program: SemanticProgram): BoundProgram {
  const root = createScope(null);
  const bound: BoundProgram = {
    program,
    env: createTypeEnv(),
    signatures: new Map(BUILTIN_SIGNATURES),
    root,
    scopes: new WeakMap(),
  };
  for (const node of program.body) bindNode(node, bound, root);
  return bound;
}

export function lookup(scope: Scope, name: string): Binding | undefined {
  let current: Scope | null = scope;
  while (current) {
    const binding = current.locals.get(name);
    if (binding) return binding;
    current = current.parent;
  }
  return undefined;
}

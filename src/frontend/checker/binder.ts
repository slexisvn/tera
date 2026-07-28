import type { SemanticNode, SemanticProgram } from "./semantic-ast.js";
import {
  BUILTIN_SIGNATURES,
  GLOBAL_NAMESPACE_BINDINGS,
  cleanType,
  createTypeEnv,
  instantiateShapeForType,
  type Binding,
  type ObjectShape,
  type Signature,
  type TypeEnv,
} from "./type-system.js";

export type Scope = {
  parent: Scope | null;
  locals: Map<string, Binding>;
  signatures: Map<string, Signature>;
  signature?: Signature;
};

export type BoundProgram = {
  program: SemanticProgram;
  env: TypeEnv;
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
      if (parentShape.indexers?.length) shape.indexers = [...(shape.indexers ?? []), ...parentShape.indexers];
    }
    for (const field of node.fields) {
      shape.fields.set(field.name, { type: cleanType(field.type), optional: field.optional });
    }
    if (node.indexers.length) {
      shape.indexers = [
        ...(shape.indexers ?? []),
        ...node.indexers.map((indexer) => ({ keyType: cleanType(indexer.keyType), valueType: cleanType(indexer.valueType) })),
      ];
    }
    bound.env.interfaces.set(node.name, shape);
    return;
  }
  if (node.kind === "Function") {
    const sig = signatureFromParams(node.name, node.typeParams, node.params, node.returns);
    scope.signatures.set(node.name, sig);
    const child = createScope(scope, sig);
    bound.scopes.set(node, child);
    for (const [name, binding] of sig.params) child.locals.set(name, { ...binding, declared: true });
    for (const stmt of node.body) bindNode(stmt, bound, child);
    return;
  }
  if (node.kind === "Model") {
    const sig = signatureFromParams(node.name, [], node.params, node.name);
    scope.signatures.set(node.name, sig);
    bound.env.nominalFamilies.set(node.name, "Module");
    const forward = modelForwardSignature(node);
    if (forward) bound.env.modelForwards.set(node.name, { ...forward, name: node.name });
    const child = createScope(scope, sig);
    bound.scopes.set(node, child);
    child.locals.set(node.name, { type: node.name, optional: false });
    for (const [name, binding] of sig.params) child.locals.set(name, { ...binding, declared: true });
    const section = createScope(child, signatureFromParams(node.name, [], [], "any"));
    for (const stmt of node.body) bindNode(stmt, bound, isModelSection(stmt) ? section : child);
    return;
  }
  if (node.kind === "Class") {
    const constructor = node.members.find((member) => member.memberKind === "constructor");
    const sig = signatureFromParams(node.name, [], constructor?.fn.params ?? [], node.name);
    scope.signatures.set(node.name, sig);
    if (node.parent) bound.env.nominalFamilies.set(node.name, node.parent);
    const classScope = createScope(scope, sig);
    bound.scopes.set(node, classScope);
    classScope.locals.set(node.name, { type: node.name, optional: false });
    const staticType = `typeof ${node.name}`;
    for (const member of node.members) {
      const memberSig = signatureFromParams(member.fn.name, member.fn.typeParams, member.fn.params, member.fn.returns);
      if (member.static && member.memberKind !== "constructor") {
        scope.signatures.set(`${node.name}.${member.fn.name}`, memberSig);
      }
      const child = createScope(classScope, memberSig);
      bound.scopes.set(member.fn, child);
      child.locals.set("this", { type: member.static ? staticType : node.name, optional: false, declared: true });
      for (const [name, binding] of memberSig.params) child.locals.set(name, { ...binding, declared: true });
      for (const stmt of member.fn.body) bindNode(stmt, bound, child);
    }
    return;
  }
  if (node.kind === "Block") {
    const child = createScope(scope, scope.signature);
    if (node.catchVariable) child.locals.set(node.catchVariable, { type: "any", optional: false, declared: true });
    bound.scopes.set(node, child);
    for (const stmt of node.body) bindNode(stmt, bound, child);
    return;
  }
  if (node.kind === "For") {
    const child = createScope(scope, scope.signature);
    child.locals.set(node.variable, { type: "any", optional: false });
    bound.scopes.set(node, child);
    for (const stmt of node.body) bindNode(stmt, bound, child);
    return;
  }
  if (node.kind === "Var") {
    return;
  }
}

function isModelSection(node: SemanticNode): boolean {
  return node.kind === "Block" && node.test === undefined;
}

function modelForwardSignature(node: Extract<SemanticNode, { kind: "Model" }>): Signature | null {
  const forward = node.body.find((stmt): stmt is Extract<SemanticNode, { kind: "Function" }> => stmt.kind === "Function" && stmt.name === "forward");
  return forward ? signatureFromParams(node.name, forward.typeParams, forward.params, forward.returns) : null;
}

function createScope(parent: Scope | null, signature?: Signature): Scope {
  return { parent, locals: new Map(), signatures: new Map(), signature };
}

export function bindProgram(program: SemanticProgram): BoundProgram {
  const root = createScope(null);
  for (const [name, sig] of BUILTIN_SIGNATURES) root.signatures.set(name, sig);
  for (const [name, type] of GLOBAL_NAMESPACE_BINDINGS) root.locals.set(name, { type, optional: false, declared: true });
  const bound: BoundProgram = {
    program,
    env: createTypeEnv(),
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

export function lookupSignature(scope: Scope, name: string): Signature | undefined {
  let current: Scope | null = scope;
  while (current) {
    const signature = current.signatures.get(name);
    if (signature) return signature;
    current = current.parent;
  }
  return undefined;
}

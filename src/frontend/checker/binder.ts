import type { SemanticNode, SemanticProgram } from "./semantic-ast.js";
import {
  BUILTIN_SIGNATURES,
  GLOBAL_NAMESPACE_BINDINGS,
  arrayOfType,
  cleanType,
  createTypeEnv,
  instantiateShapeForType,
  type Binding,
  type ObjectShape,
  type RestParameter,
  type Signature,
  type TypeEnv,
} from "./type-system.js";
import { DEFAULT_CLASS_VISIBILITY } from "../../core/class-visibility.js";

export type Scope = {
  parent: Scope | null;
  locals: Map<string, Binding>;
  signatures: Map<string, Signature>;
  signature?: Signature;
  classOwner?: string | null;
};

export type BoundProgram = {
  program: SemanticProgram;
  env: TypeEnv;
  root: Scope;
  scopes: WeakMap<SemanticNode, Scope>;
  reserved: ReadonlySet<string>;
};

export type ExternalBuiltinParam = {
  name: string;
  type?: string;
  optional?: boolean;
  rest?: boolean;
};

export type ExternalBuiltinSignature = {
  name: string;
  typeParams?: string[];
  params?: ExternalBuiltinParam[];
  returns?: string;
};

export type ExternalTypeAlias = {
  name: string;
  typeParams?: string[];
  type: string;
};

export type ExternalInterfaceField = {
  type: string;
  optional?: boolean;
};

export type ExternalInterface = {
  name: string;
  typeParams?: string[];
  fields: Record<string, ExternalInterfaceField>;
};

export type ExternalValue = {
  name: string;
  type: string;
};

export type ExternalModuleSurface = {
  builtins?: readonly ExternalBuiltinSignature[];
  values?: readonly ExternalValue[];
  aliases?: readonly ExternalTypeAlias[];
  interfaces?: readonly ExternalInterface[];
};

export type BindOptions = {
  builtins?: readonly ExternalBuiltinSignature[];
  aliases?: readonly ExternalTypeAlias[];
  interfaces?: readonly ExternalInterface[];
  imports?: ExternalModuleSurface;
};

function signatureFromParams(name: string, typeParams: string[], params: Array<{ name: string; type: string; optional: boolean; rest?: boolean }>, returns: string, meta: Pick<Signature, "visibility" | "owner" | "abstract" | "async"> = {}): Signature {
  const paramMap = new Map<string, Binding>();
  const required = new Set<string>();
  const positional: string[] = [];
  let rest: RestParameter | undefined;
  for (const param of params) {
    const type = cleanType(param.type);
    if (param.rest) {
      rest = { name: param.name, type, optional: true, named: false };
      paramMap.set(param.name, { type: arrayOfType(type), optional: true });
      continue;
    }
    paramMap.set(param.name, { type, optional: param.optional });
    positional.push(param.name);
    if (!param.optional) required.add(param.name);
  }
  const signature: Signature = { name, typeParams, params: paramMap, required, positional, returns: cleanType(returns), ...meta };
  if (rest) signature.rest = rest;
  return signature;
}

function signatureFromExternal(spec: ExternalBuiltinSignature): Signature {
  return signatureFromParams(
    spec.name,
    spec.typeParams ?? [],
    (spec.params ?? []).map((param) => ({
      name: param.name,
      type: param.type ?? "any",
      optional: param.optional ?? false,
      rest: param.rest ?? false,
    })),
    spec.returns ?? "any",
  );
}

function assertExternalName(name: string, kind: string): void {
  if (!name) throw new Error(`Unnamed ${kind}`);
}

function assertUniqueExternalNames<T extends { name: string }>(values: readonly T[] | undefined, kind: string, seen = new Set<string>()): Set<string> {
  for (const value of values ?? []) {
    assertExternalName(value.name, kind);
    if (seen.has(value.name)) throw new Error(`Duplicate ${kind} '${value.name}'`);
    seen.add(value.name);
  }
  return seen;
}

function validateBindOptions(options: BindOptions): void {
  assertUniqueExternalNames(options.builtins, "checker builtin");
  const types = assertUniqueExternalNames(options.aliases, "checker type");
  assertUniqueExternalNames(options.interfaces, "checker type", types);
}

function bindExternalTypes(bound: BoundProgram, surface: ExternalModuleSurface): void {
  for (const alias of surface.aliases ?? []) {
    bound.env.aliases.set(alias.name, {
      typeParams: alias.typeParams ?? [],
      type: cleanType(alias.type),
    });
  }
  for (const spec of surface.interfaces ?? []) {
    const shape: ObjectShape = { typeParams: spec.typeParams, fields: new Map() };
    for (const [name, field] of Object.entries(spec.fields)) {
      shape.fields.set(name, { type: cleanType(field.type), optional: field.optional ?? false });
    }
    bound.env.interfaces.set(spec.name, shape);
  }
}

function bindImportedSurface(bound: BoundProgram, surface: ExternalModuleSurface): void {
  for (const spec of surface.builtins ?? []) {
    bound.root.signatures.set(spec.name, signatureFromExternal(spec));
  }
  for (const value of surface.values ?? []) {
    bound.root.locals.set(value.name, { type: cleanType(value.type), optional: false, declared: true });
  }
  bindExternalTypes(bound, surface);
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
    const sig = signatureFromParams(node.name, node.typeParams, node.params, node.returns, { async: node.async });
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
    const sig = signatureFromParams(node.name, [], constructor?.fn.params ?? [], node.name, {
      visibility: constructor?.visibility ?? DEFAULT_CLASS_VISIBILITY,
      owner: node.name,
      abstract: node.abstract,
    });
    scope.signatures.set(node.name, sig);
    if (node.abstract) bound.env.abstractClasses.add(node.name);
    if (node.parent) bound.env.nominalFamilies.set(node.name, node.parent);
    const staticType = `typeof ${node.name}`;
    scope.locals.set(node.name, { type: staticType, optional: false, declared: true });
    const classScope = createScope(scope, sig);
    classScope.classOwner = node.name;
    bound.scopes.set(node, classScope);
    classScope.locals.set(node.name, { type: staticType, optional: false });
    for (const member of node.members) {
      const memberSig = signatureFromParams(member.fn.name, member.fn.typeParams, member.fn.params, member.fn.returns, {
        visibility: member.visibility,
        owner: node.name,
        abstract: member.abstract,
      });
      if (member.static && member.memberKind !== "constructor") {
        scope.signatures.set(`${node.name}.${member.fn.name}`, memberSig);
      }
      const child = createScope(classScope, memberSig);
      child.classOwner = node.name;
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
  return { parent, locals: new Map(), signatures: new Map(), signature, classOwner: parent?.classOwner ?? null };
}

export function bindProgram(program: SemanticProgram, options: BindOptions = {}): BoundProgram {
  validateBindOptions(options);
  const root = createScope(null);
  const reserved = new Set<string>();
  for (const [name, sig] of BUILTIN_SIGNATURES) {
    root.signatures.set(name, sig);
    reserved.add(name);
  }
  for (const spec of options.builtins ?? []) {
    root.signatures.set(spec.name, signatureFromExternal(spec));
    reserved.add(spec.name);
  }
  for (const [name, type] of GLOBAL_NAMESPACE_BINDINGS) {
    root.locals.set(name, { type, optional: false, declared: true });
    reserved.add(name);
  }
  const bound: BoundProgram = {
    program,
    env: createTypeEnv(),
    root,
    scopes: new WeakMap(),
    reserved,
  };
  bindExternalTypes(bound, options);
  if (options.imports !== undefined) bindImportedSurface(bound, options.imports);
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

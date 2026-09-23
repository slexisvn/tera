import type {
  BoundProgram,
  ExternalBuiltinSignature,
  ExternalInterface,
  ExternalModuleSurface,
  ExternalTypeAlias,
  ExternalValue,
} from "../checker/index.js";
import {
  arrayElementType,
  cleanType,
  parseFunctionType,
  parseGenericType,
  tupleTypes,
  typeLiteralShape,
  type Signature,
  type TypeName,
} from "../checker/type-system.js";
import { splitTopLevel } from "../../core/type-text.js";
import type { ClassNode } from "../checker/semantic-ast.js";
import { CLASS_DATA_MEMBER, type ClassShapeMemberKind } from "../../core/class-member.js";
import { DEFAULT_CLASS_VISIBILITY, type ClassVisibility } from "../../core/class-visibility.js";
import type { ModuleRecord, ResolvedImport } from "./graph.js";

export type ModuleInterface = ExternalModuleSurface;

const ANY_TYPE = "any";
const TYPE_NAME = /^[A-Za-z_$][\w$]*$/;
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  "any",
  "unknown",
  "undefined",
  "void",
  "never",
  "null",
  "bool",
  "boolean",
  "string",
  "int",
  "float",
  "number",
  "Object",
  "Array",
  "Map",
  "Set",
  "Function",
  "Promise",
  "iterator",
]);

function signatureToExternal(signature: Signature, name: string): ExternalBuiltinSignature {
  const rest = signature.rest;
  return {
    name,
    typeParams: signature.typeParams,
    params: [
      ...signature.positional.map((param) => ({
        name: param,
        type: signature.params.get(param)?.type ?? ANY_TYPE,
        optional: !signature.required.has(param),
      })),
      ...(rest === undefined
        ? []
        : [{ name: rest.name, type: rest.type, optional: true, rest: true }]),
    ],
    returns: signature.returns,
  };
}

export interface ClassMemberSurface {
  readonly name: string;
  readonly declaredType: string;
  readonly member: ClassShapeMemberKind;
  readonly owner: string;
  readonly abstract: boolean;
  readonly visibility: ClassVisibility;
  readonly static: boolean;
}

export interface ClassSurface {
  readonly name: string;
  readonly parent: string | null;
  readonly abstract: boolean;
  readonly members: readonly ClassMemberSurface[];
  readonly constructorParams: readonly (string | null)[];
  readonly constructorParamNames: readonly string[];
}

function shapeMembers(
  bound: BoundProgram,
  shapeName: string,
  owner: string,
  isStatic: boolean,
): ClassMemberSurface[] {
  const shape = bound.env.interfaces.get(shapeName);
  if (shape === undefined) return [];
  const members: ClassMemberSurface[] = [];
  for (const [name, binding] of shape.fields) {
    members.push({
      name,
      declaredType: binding.type,
      member: binding.member ?? CLASS_DATA_MEMBER,
      owner: binding.owner ?? owner,
      abstract: binding.abstract === true,
      visibility: binding.visibility ?? DEFAULT_CLASS_VISIBILITY,
      static: isStatic,
    });
  }
  return members;
}

function setterMembers(node: ClassNode): ClassMemberSurface[] {
  const members: ClassMemberSurface[] = [];
  for (const member of node.members) {
    if (member.memberKind !== "setter") continue;
    members.push({
      name: member.fn.name,
      declaredType: member.fn.params[0]?.type ?? ANY_TYPE,
      member: "setter",
      owner: node.name,
      abstract: member.abstract,
      visibility: member.visibility,
      static: member.static,
    });
  }
  return members;
}

function classSurfaceOf(
  bound: BoundProgram,
  node: ClassNode,
  known: ReadonlyMap<string, ClassSurface>,
): ClassSurface {
  const parent = node.parent ?? null;
  const declaresConstructor = node.members.some((member) => member.memberKind === "constructor");
  const inherited = declaresConstructor || parent === null ? undefined : known.get(parent);
  const constructorSignature = bound.root.signatures.get(node.name);
  const positional = constructorSignature?.positional ?? [];
  return {
    name: node.name,
    parent,
    abstract: node.abstract,
    members: [
      ...shapeMembers(bound, node.name, node.name, false),
      ...shapeMembers(bound, `typeof ${node.name}`, node.name, true),
      ...setterMembers(node),
    ],
    constructorParams:
      inherited?.constructorParams ??
      positional.map((param) => constructorSignature?.params.get(param)?.type ?? null),
    constructorParamNames: inherited?.constructorParamNames ?? positional,
  };
}

function interfaceSurfaceOf(bound: BoundProgram, name: string): ClassSurface {
  const members: ClassMemberSurface[] = [];
  for (const member of shapeMembers(bound, name, name, false)) {
    if (parseFunctionType(member.declaredType) === null) {
      members.push({ ...member, member: CLASS_DATA_MEMBER });
      continue;
    }
    members.push({ ...member, member: "method", abstract: true });
  }
  return {
    name,
    parent: null,
    abstract: true,
    members,
    constructorParams: [],
    constructorParamNames: [],
  };
}

export function classSurfacesOf(bound: BoundProgram): ClassSurface[] {
  const surfaces: ClassSurface[] = [];
  const known = new Map<string, ClassSurface>();
  for (const node of bound.program.body) {
    if (node.kind === "Interface") {
      surfaces.push(interfaceSurfaceOf(bound, node.name));
      continue;
    }
    if (node.kind !== "Class") continue;
    const surface = classSurfaceOf(bound, node, known);
    known.set(surface.name, surface);
    surfaces.push(surface);
  }
  return surfaces;
}

export function moduleInterfaceOf(record: ModuleRecord, bound: BoundProgram): ModuleInterface {
  const builtins: ExternalBuiltinSignature[] = [];
  const values: ExternalValue[] = [];
  const aliases: ExternalTypeAlias[] = [];
  const interfaces: ExternalInterface[] = [];

  for (const [name, binding] of record.bindings) {
    if (!binding.exported) continue;
    const signature = bound.root.signatures.get(name);
    const value = bound.root.locals.get(name);
    const alias = bound.env.aliases.get(name);
    if (alias !== undefined) {
      aliases.push({ name, typeParams: alias.typeParams, type: alias.type });
      if (binding.kind === "type" || (signature === undefined && value === undefined)) continue;
    }
    const shape = bound.env.interfaces.get(name);
    if (shape !== undefined) {
      const fields: ExternalInterface["fields"] = {};
      for (const [field, value] of shape.fields) {
        fields[field] = { type: value.type, optional: value.optional };
      }
      interfaces.push({ name, typeParams: shape.typeParams, fields });
      if (binding.kind === "interface" || (signature === undefined && value === undefined)) continue;
    }
    if (signature !== undefined) {
      builtins.push(signatureToExternal(signature, name));
      continue;
    }
    values.push({ name, type: value?.type ?? ANY_TYPE });
  }

  return { builtins, values, aliases, interfaces };
}

type MutableSurface = {
  builtins: ExternalBuiltinSignature[];
  values: ExternalValue[];
  aliases: ExternalTypeAlias[];
  interfaces: ExternalInterface[];
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pushBuiltin(target: MutableSurface, entry: ExternalBuiltinSignature): void {
  const existing = target.builtins.find((item) => item.name === entry.name);
  if (existing === undefined || !sameJson(existing, entry)) target.builtins.push(entry);
}

function pushValue(target: MutableSurface, entry: ExternalValue): void {
  const existing = target.values.find((item) => item.name === entry.name);
  if (existing === undefined || !sameJson(existing, entry)) target.values.push(entry);
}

function pushAlias(target: MutableSurface, entry: ExternalTypeAlias): void {
  const existing = target.aliases.find((item) => item.name === entry.name);
  if (existing === undefined || !sameJson(existing, entry)) target.aliases.push(entry);
}

function pushInterface(target: MutableSurface, entry: ExternalInterface): void {
  const existing = target.interfaces.find((item) => item.name === entry.name);
  if (existing === undefined || !sameJson(existing, entry)) target.interfaces.push(entry);
}

function surfaceIsEmpty(surface: MutableSurface): boolean {
  return (
    surface.builtins.length === 0 &&
    surface.values.length === 0 &&
    surface.aliases.length === 0 &&
    surface.interfaces.length === 0
  );
}

function addSignatureDependencies(
  source: ModuleInterface,
  target: MutableSurface,
  signature: ExternalBuiltinSignature,
  seen: Set<string>,
): void {
  for (const param of signature.params ?? []) addTypeDependencies(source, target, param.type ?? ANY_TYPE, seen);
  addTypeDependencies(source, target, signature.returns ?? ANY_TYPE, seen);
}

function addTypeDependencies(
  source: ModuleInterface,
  target: MutableSurface,
  type: TypeName,
  seen: Set<string>,
  ignored: ReadonlySet<string> = new Set(),
): void {
  for (const name of typeDependencyNames(type, ignored)) addNamedTypeDependency(source, target, name, seen);
}

function addNamedTypeDependency(
  source: ModuleInterface,
  target: MutableSurface,
  name: string,
  seen: Set<string>,
): void {
  const clean = cleanType(name);
  if (BUILTIN_TYPES.has(clean) || seen.has(clean)) return;
  seen.add(clean);

  const alias = source.aliases?.find((entry) => entry.name === clean);
  if (alias !== undefined) {
    pushAlias(target, alias);
    addTypeDependencies(source, target, alias.type, seen, new Set(alias.typeParams ?? []));
    return;
  }

  const shape = source.interfaces?.find((entry) => entry.name === clean);
  if (shape === undefined) return;
  pushInterface(target, shape);
  const ignored = new Set(shape.typeParams ?? []);
  for (const field of Object.values(shape.fields)) addTypeDependencies(source, target, field.type, seen, ignored);
}

function typeDependencyNames(type: TypeName, ignored: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  collectTypeDependencyNames(cleanType(type), ignored, out);
  return out;
}

function collectTypeDependencyNames(type: TypeName, ignored: ReadonlySet<string>, out: Set<string>): void {
  const source = cleanType(type);
  if (!source) return;

  for (const separator of ["|", "&"] as const) {
    const parts = splitTopLevel(source, separator).map((part) => cleanType(part));
    if (parts.length > 1) {
      for (const part of parts) collectTypeDependencyNames(part, ignored, out);
      return;
    }
  }

  const signature = parseFunctionType(source);
  if (signature !== null) {
    for (const name of signature.positional) collectTypeDependencyNames(signature.params.get(name)?.type ?? ANY_TYPE, ignored, out);
    if (signature.rest !== undefined) collectTypeDependencyNames(signature.rest.type, ignored, out);
    collectTypeDependencyNames(signature.returns, ignored, out);
    return;
  }

  const element = arrayElementType(source);
  if (element !== null) {
    collectTypeDependencyNames(element, ignored, out);
    return;
  }

  const tuple = tupleTypes(source);
  if (tuple.length > 0) {
    for (const item of tuple) collectTypeDependencyNames(item, ignored, out);
    return;
  }

  const literal = typeLiteralShape(source);
  if (literal !== null) {
    for (const field of literal.fields.values()) collectTypeDependencyNames(field.type, ignored, out);
    for (const indexer of literal.indexers ?? []) collectTypeDependencyNames(indexer.valueType, ignored, out);
    return;
  }

  const generic = parseGenericType(source);
  if (generic !== null) {
    if (!ignored.has(generic.name)) out.add(generic.name);
    for (const arg of generic.args) collectTypeDependencyNames(arg, ignored, out);
    return;
  }

  if (TYPE_NAME.test(source) && !ignored.has(source)) out.add(source);
}

function renameSignature(
  surface: ModuleInterface,
  imported: string,
  local: string,
): ExternalModuleSurface | null {
  const renamed: MutableSurface = { builtins: [], values: [], aliases: [], interfaces: [] };
  const seen = new Set<string>();
  const signature = surface.builtins?.find((entry) => entry.name === imported);
  if (signature !== undefined) {
    const renamedSignature = { ...signature, name: local };
    pushBuiltin(renamed, renamedSignature);
    addSignatureDependencies(surface, renamed, signature, seen);
  }
  const alias = surface.aliases?.find((entry) => entry.name === imported);
  if (alias !== undefined) {
    const renamedAlias = { ...alias, name: local };
    pushAlias(renamed, renamedAlias);
    addTypeDependencies(surface, renamed, alias.type, seen, new Set(alias.typeParams ?? []));
  }
  const shape = surface.interfaces?.find((entry) => entry.name === imported);
  if (shape !== undefined) {
    const renamedShape = { ...shape, name: local };
    pushInterface(renamed, renamedShape);
    const ignored = new Set(shape.typeParams ?? []);
    for (const field of Object.values(shape.fields)) addTypeDependencies(surface, renamed, field.type, seen, ignored);
  }
  if (!surfaceIsEmpty(renamed)) return renamed;
  const value = surface.values?.find((entry) => entry.name === imported);
  if (value !== undefined) {
    pushValue(renamed, { ...value, name: local });
    addTypeDependencies(surface, renamed, value.type, seen);
  }
  return surfaceIsEmpty(renamed) ? null : renamed;
}

function qualifiedSurface(surface: ModuleInterface, prefix: string): ExternalModuleSurface {
  const qualified: MutableSurface = { builtins: [], values: [], aliases: [], interfaces: [] };
  const seen = new Set<string>();
  for (const entry of surface.builtins ?? []) {
    pushBuiltin(qualified, { ...entry, name: `${prefix}.${entry.name}` });
    addSignatureDependencies(surface, qualified, entry, seen);
  }
  for (const entry of surface.values ?? []) {
    pushValue(qualified, { ...entry, name: `${prefix}.${entry.name}` });
    addTypeDependencies(surface, qualified, entry.type, seen);
  }
  return qualified;
}

function mergeSurface(target: MutableSurface, source: ExternalModuleSurface): void {
  for (const entry of source.builtins ?? []) pushBuiltin(target, entry);
  for (const entry of source.values ?? []) pushValue(target, entry);
  for (const entry of source.aliases ?? []) pushAlias(target, entry);
  for (const entry of source.interfaces ?? []) pushInterface(target, entry);
}

export function importedSurface(
  imports: readonly ResolvedImport[],
  interfaces: ReadonlyMap<string, ModuleInterface>,
): ModuleInterface {
  const surface: MutableSurface = { builtins: [], values: [], aliases: [], interfaces: [] };
  const seen = new Set<string>();
  const claim = (name: string): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  };

  for (const entry of imports) {
    if (entry.local !== null) {
      if (!claim(entry.local)) continue;
      surface.values.push({ name: entry.local, type: ANY_TYPE });
      const bound = entry.boundSpec === null ? undefined : interfaces.get(entry.boundSpec);
      if (bound !== undefined) mergeSurface(surface, qualifiedSurface(bound, entry.local));
      continue;
    }
    const owner = interfaces.get(entry.module);
    for (const binding of entry.bindings) {
      if (!claim(binding.local)) continue;
      if (binding.submodule !== null || owner === undefined) {
        surface.values.push({ name: binding.local, type: ANY_TYPE });
        continue;
      }
      const renamed = renameSignature(owner, binding.imported, binding.local);
      if (renamed === null) surface.values.push({ name: binding.local, type: ANY_TYPE });
      else mergeSurface(surface, renamed);
    }
  }
  return surface;
}

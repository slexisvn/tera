import type {
  BoundProgram,
  ExternalBuiltinSignature,
  ExternalInterface,
  ExternalModuleSurface,
  ExternalTypeAlias,
  ExternalValue,
} from "../checker/index.js";
import { parseFunctionType, type Signature } from "../checker/type-system.js";
import type { ClassNode } from "../checker/semantic-ast.js";
import { CLASS_DATA_MEMBER, type ClassShapeMemberKind } from "../../core/class-member.js";
import { DEFAULT_CLASS_VISIBILITY, type ClassVisibility } from "../../core/class-visibility.js";
import type { ModuleRecord, ResolvedImport } from "./graph.js";

export type ModuleInterface = ExternalModuleSurface;

const ANY_TYPE = "any";

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
    if (parseFunctionType(member.declaredType) === null) continue;
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
    if (binding.kind === "type") {
      const alias = bound.env.aliases.get(name);
      if (alias !== undefined) {
        aliases.push({ name, typeParams: alias.typeParams, type: alias.type });
        continue;
      }
    }
    const shape = bound.env.interfaces.get(name);
    if (shape !== undefined) {
      const fields: ExternalInterface["fields"] = {};
      for (const [field, value] of shape.fields) {
        fields[field] = { type: value.type, optional: value.optional };
      }
      interfaces.push({ name, typeParams: shape.typeParams, fields });
      if (binding.kind === "interface") continue;
    }
    const signature = bound.root.signatures.get(name);
    if (signature !== undefined) {
      builtins.push(signatureToExternal(signature, name));
      continue;
    }
    values.push({ name, type: bound.root.locals.get(name)?.type ?? ANY_TYPE });
  }

  return { builtins, values, aliases, interfaces };
}

function renameSignature(
  surface: ModuleInterface,
  imported: string,
  local: string,
): ExternalModuleSurface | null {
  const signature = surface.builtins?.find((entry) => entry.name === imported);
  if (signature !== undefined) return { builtins: [{ ...signature, name: local }] };
  const alias = surface.aliases?.find((entry) => entry.name === imported);
  if (alias !== undefined) return { aliases: [{ ...alias, name: local }] };
  const shape = surface.interfaces?.find((entry) => entry.name === imported);
  if (shape !== undefined) return { interfaces: [{ ...shape, name: local }] };
  const value = surface.values?.find((entry) => entry.name === imported);
  if (value !== undefined) return { values: [{ ...value, name: local }] };
  return null;
}

type MutableSurface = {
  builtins: ExternalBuiltinSignature[];
  values: ExternalValue[];
  aliases: ExternalTypeAlias[];
  interfaces: ExternalInterface[];
};

function qualifiedSurface(surface: ModuleInterface, prefix: string): ExternalModuleSurface {
  return {
    builtins: (surface.builtins ?? []).map((entry) => ({ ...entry, name: `${prefix}.${entry.name}` })),
    values: (surface.values ?? []).map((entry) => ({ ...entry, name: `${prefix}.${entry.name}` })),
  };
}

function mergeSurface(target: MutableSurface, source: ExternalModuleSurface): void {
  for (const entry of source.builtins ?? []) target.builtins.push(entry);
  for (const entry of source.values ?? []) target.values.push(entry);
  for (const entry of source.aliases ?? []) target.aliases.push(entry);
  for (const entry of source.interfaces ?? []) target.interfaces.push(entry);
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

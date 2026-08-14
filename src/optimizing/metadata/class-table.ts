import {
  CLASS_CALLABLE_KINDS,
  CLASS_DATA_MEMBER,
  type ClassCallableKind,
} from "../../core/class-member.js";
import type { ClassMemberSurface, ClassSurface } from "../../frontend/modules/interface.js";
import { TERA_STATICS_BYTES } from "../target/runtime-layout.js";
import { builtinTypeEnv, latticeFromDeclaredType, type NominalTypes } from "../types/declared.js";
import { TypeKind } from "../types/lattice.js";
import {
  aotScalarOf,
  isStorableScalar,
  scalarAlignment,
  scalarWidth,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_TEXT,
  type AotScalar,
} from "../types/scalar.js";
import type { DeclaredSignature } from "../types/signature.js";
import {
  classMemberSymbol,
  classStaticFieldSymbol,
  memberSignature,
  type ClassMemberFunction,
} from "./class-symbols.js";

export const CLASS_SHAPE_ID_OFFSET = 0;
export const CLASS_FLAGS_OFFSET = 4;
export const CLASS_HEADER_BYTES = 8;
export const CLASS_ALIGNMENT_BYTES = 8;

export interface ClassField {
  readonly name: string;
  readonly declaredType: string;
  readonly offset: number;
  readonly scalar: AotScalar;
  readonly owner: string;
}

export interface ClassMethod {
  readonly name: string;
  readonly owner: string;
  readonly symbol: string;
  readonly signature: DeclaredSignature;
  readonly abstract: boolean;
}

export interface ClassStaticField {
  readonly name: string;
  readonly owner: string;
  readonly symbol: string;
  readonly declaredType: string;
  readonly offset: number;
  readonly scalar: AotScalar;
}

export type ClassCallables = ReadonlyMap<ClassCallableKind, ReadonlyMap<string, ClassMethod>>;

export interface ClassShape {
  readonly id: number;
  readonly name: string;
  readonly parent: string | null;
  readonly abstract: boolean;
  readonly fields: ReadonlyMap<string, ClassField>;
  readonly callables: ClassCallables;
  readonly staticCallables: ClassCallables;
  readonly staticFields: ReadonlyMap<string, ClassStaticField>;
  readonly size: number;
  readonly constructorSymbol: string;
  readonly constructorSignature: DeclaredSignature;
  readonly constructorParamNames: readonly string[];
  readonly unsupported: readonly string[];
}

export interface ClassTable extends NominalTypes {
  defineSynthetic(surface: ClassSurface): ClassShape;
  shapeOf(name: string): ClassShape | null;
  shapeById(id: number): ClassShape | null;
  shapes(): readonly ClassShape[];
  subclassesOf(name: string): readonly ClassShape[];
  implementationsOf(
    name: string,
    member: string,
    kind: ClassCallableKind,
  ): readonly ClassMethod[];
}

function ancestryOf(classes: ClassTable, shape: ClassShape): readonly ClassShape[] {
  const line: ClassShape[] = [];
  let walk: ClassShape | null = shape;
  while (walk !== null) {
    line.push(walk);
    walk = walk.parent === null ? null : classes.shapeOf(walk.parent);
  }
  return line;
}

export function commonAncestorOf(
  classes: ClassTable,
  shapes: readonly ClassShape[],
): ClassShape | null {
  let common = shapes[0];
  if (common === undefined) return null;
  for (const shape of shapes.slice(1)) {
    const ancestors = new Set<string>(ancestryOf(classes, common).map((entry) => entry.name));
    const shared = ancestryOf(classes, shape).find((entry) => ancestors.has(entry.name));
    if (shared === undefined) return null;
    common = shared;
  }
  return common;
}

export function callableOf(
  callables: ClassCallables,
  kind: ClassCallableKind,
  name: string,
): ClassMethod | null {
  return callables.get(kind)?.get(name) ?? null;
}

const FIRST_CLASS_ID = 1;
const SIGNATURE_ARROW = "->";

function alignUp(value: number, alignment: number): number {
  return alignment <= 1 ? value : Math.ceil(value / alignment) * alignment;
}

function fieldScalarOf(declaredType: string, nominal: NominalTypes): AotScalar | null {
  const type = latticeFromDeclaredType(declaredType, builtinTypeEnv(), nominal);
  if (type.kind === TypeKind.Any) return null;
  const scalar = isStorableScalar(aotScalarOf(type));
  return scalar === SCALAR_STRING ? SCALAR_TEXT : scalar;
}

function memberSignatureOf(member: ClassMemberSurface): DeclaredSignature {
  const receiver = member.static ? [] : [member.owner];
  if (member.member === "getter") return { params: receiver, returns: member.declaredType };
  if (member.member === "setter") {
    return { params: [...receiver, member.declaredType], returns: null };
  }
  const arrow = member.declaredType.indexOf(SIGNATURE_ARROW);
  if (arrow < 0) return { params: receiver, returns: member.declaredType };
  const head = member.declaredType.slice(0, arrow).trim().replace(/^\(|\)$/g, "");
  const declared = head.length === 0 ? [] : head.split(",").map((part) => part.trim());
  return {
    params: [...receiver, ...declared],
    returns: member.declaredType.slice(arrow + SIGNATURE_ARROW.length).trim(),
  };
}

function callableKindOf(member: ClassMemberSurface): ClassCallableKind | null {
  const kind = member.member;
  return kind === CLASS_DATA_MEMBER ? null : kind;
}

function methodOf(member: ClassMemberSurface, kind: ClassCallableKind): ClassMethod {
  return {
    name: member.name,
    owner: member.owner,
    symbol: classMemberSymbol({
      name: member.name,
      classOwnerName: member.owner,
      classMemberKind: kind,
      classMemberStatic: member.static,
    })!,
    signature: memberSignatureOf(member),
    abstract: member.abstract,
  };
}

type MutableCallables = Map<ClassCallableKind, Map<string, ClassMethod>>;

function inheritCallables(parent: ClassCallables | null): MutableCallables {
  const callables: MutableCallables = new Map();
  for (const kind of CLASS_CALLABLE_KINDS) {
    callables.set(kind, new Map(parent?.get(kind) ?? []));
  }
  return callables;
}

function orderedByInheritance(surfaces: readonly ClassSurface[]): ClassSurface[] {
  const byName = new Map(surfaces.map((surface) => [surface.name, surface]));
  const ordered: ClassSurface[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const visit = (surface: ClassSurface): void => {
    if (placed.has(surface.name) || visiting.has(surface.name)) return;
    visiting.add(surface.name);
    const parent = surface.parent === null ? undefined : byName.get(surface.parent);
    if (parent !== undefined) visit(parent);
    visiting.delete(surface.name);
    placed.add(surface.name);
    ordered.push(surface);
  };

  for (const surface of surfaces) visit(surface);
  return ordered;
}

class Table implements ClassTable {
  private readonly byName = new Map<string, ClassShape>();
  private readonly byId = new Map<number, ClassShape>();
  private readonly ids = new Map<string, number>();
  private readonly cones = new Map<string, ClassShape[]>();
  private readonly staticOffsets = new Map<string, number>();
  private staticsSize = 0;

  constructor(surfaces: readonly ClassSurface[]) {
    let nextId = FIRST_CLASS_ID;
    for (const surface of surfaces) this.ids.set(surface.name, nextId++);
    for (const surface of orderedByInheritance(surfaces)) this.define(surface);
    this.buildCones(surfaces);
  }

  defineSynthetic(surface: ClassSurface): ClassShape {
    const existing = this.byName.get(surface.name);
    if (existing !== undefined) return existing;
    this.ids.set(surface.name, FIRST_CLASS_ID + this.byId.size);
    this.define(surface);
    const shape = this.byName.get(surface.name)!;
    this.cones.set(surface.name, [shape]);
    for (let parent = shape.parent; parent !== null; ) {
      const cone = this.cones.get(parent);
      if (cone !== undefined) cone.push(shape);
      parent = this.byName.get(parent)?.parent ?? null;
    }
    return shape;
  }

  shapeIdOf(name: string): number | null {
    return this.ids.get(name) ?? null;
  }

  shapeOf(name: string): ClassShape | null {
    return this.byName.get(name) ?? null;
  }

  shapeById(id: number): ClassShape | null {
    return this.byId.get(id) ?? null;
  }

  shapes(): readonly ClassShape[] {
    return [...this.byId.values()].sort((left, right) => left.id - right.id);
  }

  subclassesOf(name: string): readonly ClassShape[] {
    return this.cones.get(name) ?? [];
  }

  implementationsOf(
    name: string,
    member: string,
    kind: ClassCallableKind,
  ): readonly ClassMethod[] {
    const seen = new Set<string>();
    const targets: ClassMethod[] = [];
    for (const shape of this.subclassesOf(name)) {
      if (shape.abstract) continue;
      const target = callableOf(shape.callables, kind, member);
      if (target === null || target.abstract || seen.has(target.symbol)) continue;
      seen.add(target.symbol);
      targets.push(target);
    }
    return targets;
  }

  private reserveStatic(symbol: string, scalar: AotScalar): number | null {
    const existing = this.staticOffsets.get(symbol);
    if (existing !== undefined) return existing;
    const width = scalarWidth(scalar);
    const offset = alignUp(this.staticsSize, width);
    if (offset + width > TERA_STATICS_BYTES) return null;
    this.staticOffsets.set(symbol, offset);
    this.staticsSize = offset + width;
    return offset;
  }

  private define(surface: ClassSurface): void {
    const parent = surface.parent === null ? null : this.byName.get(surface.parent) ?? null;
    const fields = new Map<string, ClassField>(parent?.fields);
    const callables = inheritCallables(parent?.callables ?? null);
    const staticCallables = inheritCallables(parent?.staticCallables ?? null);
    const staticFields = new Map<string, ClassStaticField>(parent?.staticFields);
    const unsupported = [...(parent?.unsupported ?? [])];

    let cursor = parent === null ? CLASS_HEADER_BYTES : parent.size;
    for (const member of surface.members) {
      if (member.member !== CLASS_DATA_MEMBER) continue;
      const scalar = fieldScalarOf(member.declaredType, this);
      if (member.static) {
        if (scalar === null) continue;
        const symbol = classStaticFieldSymbol(member.owner, member.name);
        const offset = this.reserveStatic(symbol, scalar);
        if (offset === null) {
          unsupported.push(member.name);
          continue;
        }
        staticFields.set(member.name, {
          name: member.name,
          owner: member.owner,
          symbol,
          declaredType: member.declaredType,
          offset,
          scalar,
        });
        continue;
      }
      if (fields.has(member.name)) continue;
      if (scalar === null) {
        unsupported.push(member.name);
        continue;
      }
      cursor = alignUp(cursor, scalarAlignment(scalar));
      fields.set(member.name, {
        name: member.name,
        declaredType: member.declaredType,
        offset: cursor,
        scalar,
        owner: member.owner,
      });
      cursor += scalarWidth(scalar);
    }

    for (const member of surface.members) {
      const kind = callableKindOf(member);
      if (kind === null) continue;
      const table = member.static ? staticCallables : callables;
      table.get(kind)!.set(member.name, methodOf(member, kind));
    }

    const shape: ClassShape = {
      id: this.ids.get(surface.name)!,
      name: surface.name,
      parent: surface.parent,
      abstract: surface.abstract,
      fields,
      callables,
      staticCallables,
      staticFields,
      size: alignUp(cursor, CLASS_ALIGNMENT_BYTES),
      constructorSymbol: surface.name,
      constructorSignature: {
        params: [surface.name, ...surface.constructorParams],
        returns: surface.name,
      },
      constructorParamNames: surface.constructorParamNames,
      unsupported,
    };
    this.byName.set(shape.name, shape);
    this.byId.set(shape.id, shape);
  }

  private buildCones(surfaces: readonly ClassSurface[]): void {
    const children = new Map<string, string[]>();
    for (const surface of surfaces) {
      if (surface.parent === null) continue;
      const siblings = children.get(surface.parent);
      if (siblings === undefined) children.set(surface.parent, [surface.name]);
      else siblings.push(surface.name);
    }

    for (const surface of surfaces) {
      const cone: ClassShape[] = [];
      const pending = [surface.name];
      const seen = new Set<string>();
      while (pending.length > 0) {
        const name = pending.pop()!;
        if (seen.has(name)) continue;
        seen.add(name);
        const shape = this.byName.get(name);
        if (shape !== undefined) cone.push(shape);
        pending.push(...(children.get(name) ?? []));
      }
      this.cones.set(surface.name, cone);
    }
  }
}

function callableBySymbol(
  callables: ClassCallables,
  kind: ClassCallableKind,
  symbol: string,
): ClassMethod | null {
  for (const method of callables.get(kind)?.values() ?? []) {
    if (method.symbol === symbol) return method;
  }
  return null;
}

function informativeType(declared: string | null | undefined, nominal: NominalTypes): boolean {
  if (declared === null || declared === undefined) return false;
  return latticeFromDeclaredType(declared, builtinTypeEnv(), nominal).kind !== TypeKind.Any;
}

export function declaredMemberSignature(
  member: ClassMemberFunction & { readonly classMemberStatic?: boolean },
  classes: ClassTable | null,
  receiver: boolean,
): DeclaredSignature | null {
  const declared = receiver ? memberSignature(member) : member.declaredSignature ?? null;
  if (classes === null || declared === null) return declared;
  if (informativeType(declared.returns, classes)) return declared;
  const owner = member.classOwnerName;
  const kind = member.classMemberKind;
  const name = member.name;
  const shape = typeof owner === "string" ? classes.shapeOf(owner) : null;
  if (shape === null || typeof name !== "string") return declared;
  if (kind === undefined || kind === null || kind === "constructor") return declared;
  const table = member.classMemberStatic === true ? shape.staticCallables : shape.callables;
  const target = callableOf(table, kind, name) ?? callableBySymbol(table, kind, name);
  if (target === null || !informativeType(target.signature.returns, classes)) return declared;
  return { ...declared, returns: target.signature.returns };
}

export function buildClassTable(surfaces: readonly ClassSurface[]): ClassTable {
  return new Table(surfaces);
}

export function referenceFieldOffsets(shape: ClassShape): readonly number[] {
  const offsets: number[] = [];
  for (const field of shape.fields.values()) {
    if (field.scalar === SCALAR_POINTER) offsets.push(field.offset);
  }
  return offsets.sort((left, right) => left - right);
}

export function declaredFieldsOf(shape: ClassShape): string[] {
  const declared: string[] = [];
  for (const field of shape.fields.values()) {
    if (field.owner === shape.name) declared.push(field.name);
  }
  return declared.concat(shape.unsupported).sort();
}

export function constructorFieldDisagreement(
  shape: ClassShape,
  observed: readonly string[],
): string | null {
  const fromSource = declaredFieldsOf(shape);
  const fromBytecode = [...observed].sort();
  if (fromSource.length === fromBytecode.length) {
    if (fromSource.every((name, index) => name === fromBytecode[index])) return null;
  }
  const missing = fromBytecode.filter((name) => !fromSource.includes(name));
  const extra = fromSource.filter((name) => !fromBytecode.includes(name));
  const parts = [
    missing.length > 0 ? `constructor assigns ${missing.join(", ")}` : null,
    extra.length > 0 ? `declared shape has ${extra.join(", ")}` : null,
  ].filter((part) => part !== null);
  return `class ${shape.name} has fields the compiler cannot agree on: ${parts.join("; ")}`;
}

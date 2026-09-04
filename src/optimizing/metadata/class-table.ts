import {
  CLASS_CALLABLE_KINDS,
  CLASS_DATA_MEMBER,
  type ClassCallableKind,
} from "../../core/class-member.js";
import type { ClassMemberSurface, ClassSurface } from "../../frontend/modules/interface.js";
import { splitCellKey } from "../../runtime/intrinsics/global-cells.js";
import { resolveType, typeLiteralShape, type TypeEnv } from "../../frontend/checker/type-system.js";
import {
  TERA_LINK_BYTES,
  TERA_MARK_FLAG,
  TERA_BLOCK_FLAGS,
  TERA_REMEMBERED_FLAG,
  TERA_STATICS_BYTES,
} from "../target/runtime-layout.js";
import {
  builtinTypeEnv,
  declaredAcceptsNull,
  declaredNameOf,
  DECLARED_INT,
  latticeFromDeclaredType,
  presentTypeName,
  type NominalTypes,
} from "../types/declared.js";
import { acceptsNull, joinTypes, TypeKind, type LatticeType } from "../types/lattice.js";
import {
  aotScalarOf,
  isReferenceScalar,
  isStorableScalar,
  scalarAlignment,
  scalarWidth,
  SCALAR_CODE,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_TEXT,
  type AotScalar,
} from "../types/scalar.js";
import { COLLECTION_GLOBALS } from "../prelude/collections.js";
import { functionSignatureOf, type DeclaredSignature } from "../types/signature.js";
import {
  classMemberSymbol,
  classStaticFieldSymbol,
  globalVariableSymbol,
  memberSignature,
  type ClassMemberFunction,
} from "./class-symbols.js";

export const CLASS_SHAPE_ID_OFFSET = 0;
export const CLASS_FLAGS_OFFSET = 4;
export const CLASS_HEADER_BYTES = 8;
export const CLASS_ALIGNMENT_BYTES = 8;

export const CLASS_ID_PROP = "classId";
export const FIELD_TYPE_PROP = "fieldType";
export const FIELD_SCALAR_PROP = "fieldScalar";
export const INSTANCE_SIZE_PROP = "instanceSize";
export const VALUE_CLASS_PROP = "valueClassId";
export const ARRAY_ELEMENT_SCALAR_PROP = "elementScalar";

const ABSENT_TYPE = "null";
const UNION_IN_TYPE = /\s*\|\s*/g;
const UNION_IN_NAME = "$or$";
const LITERAL_SHAPE_PREFIX = "tera_literal";
const ARRAY_SHAPE_PREFIX = "tera_array";
const ARRAY_BUFFER_PREFIX = "tera_array_buffer";
const ARRAY_LENGTH_FIELD = "length";
const ARRAY_CAPACITY_FIELD = "capacity";
const ARRAY_ELEMENTS_FIELD = "elements";

export const ARRAY_LENGTH_OFFSET = CLASS_HEADER_BYTES;
export const ARRAY_CAPACITY_OFFSET = ARRAY_LENGTH_OFFSET + scalarWidth(SCALAR_INT32);
export const ARRAY_ELEMENTS_OFFSET = ARRAY_CAPACITY_OFFSET + scalarWidth(SCALAR_INT32);
export const BUFFER_ELEMENTS_OFFSET = CLASS_HEADER_BYTES;
export const ARRAY_INITIAL_CAPACITY = 1;
export const ARRAY_GROWTH_FACTOR = 2;

export const FREE_BLOCK_BYTES = CLASS_HEADER_BYTES + TERA_LINK_BYTES;
export const CLEAR_MARK = -1 - TERA_MARK_FLAG;
export const CLEAR_BLOCK_FLAGS = -1 - TERA_BLOCK_FLAGS;
export const CLEAR_REMEMBERED = -1 - TERA_REMEMBERED_FLAG;
export const GROWTH_SHIFT = Math.log2(ARRAY_GROWTH_FACTOR);
export const ALIGNMENT_ROUNDING = CLASS_ALIGNMENT_BYTES - 1;

export function bufferElementOffset(element: AotScalar, index: number): number {
  return BUFFER_ELEMENTS_OFFSET + index * scalarWidth(element);
}

export function arrayBufferBytes(element: AotScalar, capacity: number): number {
  return alignUp(bufferElementOffset(element, capacity), CLASS_ALIGNMENT_BYTES);
}

function arrayShapeName(declaredType: string): string {
  return `${ARRAY_SHAPE_PREFIX}$${declaredType}`;
}

function arrayBufferName(element: AotScalar): string {
  return `${ARRAY_BUFFER_PREFIX}$${element}`;
}

export interface ArrayLayout {
  readonly element: AotScalar;
  readonly declaredType: string;
  readonly buffer: ClassShape;
}

export function declaredTypeOf(type: LatticeType, classes: ClassTable): string | null {
  if (type.kind === TypeKind.Object) {
    return typeof type.map === "number" ? classes.shapeById(type.map)?.name ?? null : null;
  }
  return declaredNameOf(type);
}

export function heldTypeOf(type: LatticeType, classes: ClassTable): string | null {
  if (type.kind === TypeKind.Nullish) return ABSENT_TYPE;
  const named = declaredTypeOf(type, classes);
  if (named === null) return null;
  return acceptsNull(type) ? `${named} | ${ABSENT_TYPE}` : named;
}


function syntheticShape(id: number, name: string, fields: Map<string, ClassField>): ClassShape {
  let cursor = CLASS_HEADER_BYTES;
  for (const field of fields.values()) {
    cursor = Math.max(cursor, field.offset + scalarWidth(field.scalar));
  }
  return {
    id,
    name,
    parent: null,
    abstract: false,
    fields,
    callables: inheritCallables(null),
    staticCallables: inheritCallables(null),
    staticFields: new Map(),
    size: alignUp(cursor, CLASS_ALIGNMENT_BYTES),
    tailReferences: false,
    constructorSymbol: name,
    constructorSignature: { params: [name], returns: name },
    constructorParamNames: [],
    unsupported: [],
  };
}

function arrayShape(id: number, name: string, buffer: string): ClassShape {
  const count = (field: string, offset: number): [string, ClassField] => [
    field,
    { name: field, declaredType: DECLARED_INT, offset, scalar: SCALAR_INT32, owner: name },
  ];
  return syntheticShape(
    id,
    name,
    new Map<string, ClassField>([
      count(ARRAY_LENGTH_FIELD, ARRAY_LENGTH_OFFSET),
      count(ARRAY_CAPACITY_FIELD, ARRAY_CAPACITY_OFFSET),
      [
        ARRAY_ELEMENTS_FIELD,
        {
          name: ARRAY_ELEMENTS_FIELD,
          declaredType: buffer,
          offset: ARRAY_ELEMENTS_OFFSET,
          scalar: SCALAR_POINTER,
          owner: name,
        },
      ],
    ]),
  );
}

function arrayBufferShape(id: number, name: string, element: AotScalar): ClassShape {
  return {
    ...syntheticShape(id, name, new Map()),
    tailReferences: element === SCALAR_POINTER,
  };
}

export interface LiteralField {
  readonly name: string;
  readonly declaredType: string;
}

export function shapeForDeclared(
  classes: ClassTable,
  declared: string | null | undefined,
): ClassShape | null {
  if (declared === null || declared === undefined) return null;
  const id = classes.shapeIdOf(declared);
  return id === null ? null : classes.shapeById(id);
}

export function isLiteralShapeName(name: string): boolean {
  return name.startsWith(`${LITERAL_SHAPE_PREFIX}$`);
}

function shapeSafeType(declaredType: string): string {
  return declaredType.replace(UNION_IN_TYPE, () => UNION_IN_NAME);
}

export function literalShapeSurface(fields: readonly LiteralField[]): ClassSurface {
  const name = `${LITERAL_SHAPE_PREFIX}$${fields
    .map((field) => `${field.name}_${shapeSafeType(field.declaredType)}`)
    .join("$")}`;
  return {
    name,
    parent: null,
    abstract: false,
    members: fields.map((field) => ({
      name: field.name,
      declaredType: field.declaredType,
      member: CLASS_DATA_MEMBER,
      owner: name,
      abstract: false,
      visibility: "public",
      static: false,
    })),
    constructorParams: [],
    constructorParamNames: [],
  };
}

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

export interface GlobalVariable {
  readonly name: string;
  readonly declaredType: string;
  readonly offset: number;
  readonly scalar: AotScalar;
}

export interface GeneratorShape {
  readonly frame: ClassShape;
  readonly resume: string;
  readonly yields: string;
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
  readonly tailReferences: boolean;
  readonly constructorSymbol: string;
  readonly constructorSignature: DeclaredSignature;
  readonly constructorParamNames: readonly string[];
  readonly unsupported: readonly string[];
}

export interface ClassTable extends NominalTypes {
  defineSynthetic(surface: ClassSurface): ClassShape;
  declareThrownType(declaredType: string): void;
  thrownType(): string | null;
  declareGlobal(name: string, declaredType: string): GlobalVariable | null;
  declareStaticField(owner: string, name: string, declaredType: string): boolean;
  retypeField(owner: string, name: string, declaredType: string): boolean;
  globalOf(name: string): GlobalVariable | null;
  globals(): readonly GlobalVariable[];
  declareGenerator(producer: string, generator: GeneratorShape): void;
  generatorOf(producer: string): GeneratorShape | null;
  shapeOf(name: string): ClassShape | null;
  shapeById(id: number): ClassShape | null;
  shapes(): readonly ClassShape[];
  defineArray(element: LatticeType, elementName?: string): ClassShape | null;
  arrayLayoutOf(shape: ClassShape): ArrayLayout | null;
  dispatchConeOf(name: string): readonly ClassShape[];
  standInsFor(shape: ClassShape): readonly ClassShape[];
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

export function descendsFrom(
  classes: ClassTable,
  shape: ClassShape,
  ancestor: string,
): boolean {
  return ancestryOf(classes, shape).some((entry) => entry.name === ancestor);
}

function commonAncestorOf(
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

function narrowestOf(classes: ClassTable, shapes: readonly ClassShape[]): ClassShape | null {
  let narrowest: ClassShape | null = null;
  let reached = Infinity;
  for (const shape of shapes) {
    const covered = classes.dispatchConeOf(shape.name).length;
    if (covered >= reached) continue;
    narrowest = shape;
    reached = covered;
  }
  return narrowest;
}

function commonStandInOf(
  classes: ClassTable,
  shapes: readonly ClassShape[],
): ClassShape | null {
  let shared: ClassShape[] | null = null;
  for (const shape of shapes) {
    const carried = new Set(classes.standInsFor(shape).map((entry) => entry.name));
    shared = (shared ?? classes.standInsFor(shapes[0]!)).filter((entry) =>
      carried.has(entry.name),
    );
    if (shared.length === 0) return null;
  }
  return shared === null ? null : narrowestOf(classes, shared);
}

export function commonShapeOf(
  classes: ClassTable,
  shapes: readonly ClassShape[],
): ClassShape | null {
  return commonAncestorOf(classes, shapes) ?? commonStandInOf(classes, shapes);
}

function literalFieldNamesOf(shape: ClassShape): readonly string[] | null {
  return isLiteralShapeName(shape.name) ? [...shape.fields.keys()] : null;
}

function joinedFieldType(classes: ClassTable, held: readonly string[]): string | null {
  const first = held[0];
  if (first === undefined) return null;
  if (held.every((entry) => entry === first)) return first;
  let joined: LatticeType | null = null;
  for (const entry of held) {
    joined = joinTypes(joined, latticeFromDeclaredType(entry, builtinTypeEnv(), classes));
  }
  return joined === null ? null : heldTypeOf(joined, classes);
}

export function joinedLiteralShape(
  classes: ClassTable,
  shapes: readonly ClassShape[],
): ClassShape | null {
  const names = shapes[0] === undefined ? null : literalFieldNamesOf(shapes[0]);
  if (names === null) return null;
  const held = new Map<string, string[]>(names.map((name) => [name, []]));
  for (const shape of shapes) {
    const carried = literalFieldNamesOf(shape);
    if (carried === null || carried.length !== names.length) return null;
    for (const [at, name] of carried.entries()) {
      if (names[at] !== name) return null;
      held.get(name)!.push(shape.fields.get(name)!.declaredType);
    }
  }
  const fields: LiteralField[] = [];
  for (const name of names) {
    const declaredType = joinedFieldType(classes, held.get(name)!);
    if (declaredType === null) return null;
    fields.push({ name, declaredType });
  }
  return classes.defineSynthetic(literalShapeSurface(fields));
}

export function sameFieldLayout(left: ClassShape, right: ClassShape): boolean {
  if (left === right) return true;
  if (left.size !== right.size || left.fields.size !== right.fields.size) return false;
  for (const [name, field] of left.fields) {
    const held = right.fields.get(name);
    if (held === undefined) return false;
    if (held.offset !== field.offset || held.scalar !== field.scalar) return false;
  }
  return true;
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

export function nullableScalarOf(
  declaredType: string,
  nominal: NominalTypes | null,
): AotScalar | null {
  const present = presentTypeName(declaredType);
  if (present.length === 0) return SCALAR_FLOAT64;
  const scalar = isStorableScalar(
    aotScalarOf(latticeFromDeclaredType(present, builtinTypeEnv(), nominal ?? undefined)),
  );
  if (scalar === null) return null;
  return isReferenceScalar(scalar) ? scalar : SCALAR_FLOAT64;
}

export function declaredAotScalar(
  declared: string | null | undefined,
  nominal: NominalTypes | null,
): AotScalar | null {
  if (declared === null || declared === undefined) return null;
  if (functionSignatureOf(declared) !== null) return SCALAR_CODE;
  return declaredAcceptsNull(declared)
    ? nullableScalarOf(declared, nominal)
    : aotScalarOf(latticeFromDeclaredType(declared, builtinTypeEnv(), nominal ?? undefined));
}

function fieldScalarOf(declaredType: string, nominal: NominalTypes): AotScalar | null {
  if (functionSignatureOf(declaredType) !== null) return SCALAR_CODE;
  if (COLLECTION_GLOBALS.has(declaredType)) return SCALAR_POINTER;
  const type = latticeFromDeclaredType(declaredType, builtinTypeEnv(), nominal);
  if (declaredAcceptsNull(declaredType) || type.kind === TypeKind.Nullish) {
    return nullableScalarOf(declaredType, nominal);
  }
  if (type.kind === TypeKind.Any) return null;
  const scalar = isStorableScalar(aotScalarOf(type));
  if (scalar === null) return null;
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
  private readonly cones = new Map<string, readonly ClassShape[]>();
  private readonly byMember = new Map<string, ClassShape[]>();
  private readonly abstractByMember = new Map<string, ClassShape[]>();
  private readonly standIns = new Map<string, readonly ClassShape[]>();
  private readonly staticOffsets = new Map<string, number>();
  private readonly arrays = new Map<string, ArrayLayout>();
  private readonly globalVariables = new Map<string, GlobalVariable>();
  private thrown: string | null = null;
  private readonly generatorShapes = new Map<string, GeneratorShape>();
  private readonly structural = new Map<string, ClassShape | null>();
  private staticsSize = 0;
  private nextId = FIRST_CLASS_ID;

  constructor(
    surfaces: readonly ClassSurface[],
    private readonly env: TypeEnv = builtinTypeEnv(),
  ) {
    for (const surface of surfaces) this.reserveId(surface.name);
    for (const surface of orderedByInheritance(surfaces)) this.define(surface);
  }

  private reserveId(name: string): number {
    const reserved = this.ids.get(name);
    if (reserved !== undefined) return reserved;
    const id = this.nextId++;
    this.ids.set(name, id);
    return id;
  }

  defineSynthetic(surface: ClassSurface): ClassShape {
    const existing = this.byName.get(surface.name);
    if (existing !== undefined) return existing;
    this.reserveId(surface.name);
    this.define(surface);
    this.cones.clear();
    this.standIns.clear();
    return this.byName.get(surface.name)!;
  }

  defineArray(element: LatticeType, elementName?: string): ClassShape | null {
    const declared = elementName ?? heldTypeOf(element, this);
    const stored = isStorableScalar(aotScalarOf(element));
    if (declared === null || stored === null) return null;
    const scalar = stored === SCALAR_STRING ? SCALAR_TEXT : stored;
    const buffer = this.mint(arrayBufferName(scalar), (id, name) =>
      arrayBufferShape(id, name, scalar),
    );
    const shape = this.mint(arrayShapeName(declared), (id, name) =>
      arrayShape(id, name, buffer.name),
    );
    this.arrays.set(shape.name, { element: scalar, declaredType: declared, buffer });
    return shape;
  }

  arrayLayoutOf(shape: ClassShape): ArrayLayout | null {
    return this.arrays.get(shape.name) ?? null;
  }

  private mint(name: string, build: (id: number, name: string) => ClassShape): ClassShape {
    const existing = this.byName.get(name);
    if (existing !== undefined) return existing;
    this.adopt(build(this.reserveId(name), name));
    this.cones.clear();
    return this.byName.get(name)!;
  }

  shapeIdOf(name: string): number | null {
    const known = this.ids.get(name) ?? this.lookup(name)?.id;
    return known ?? this.structuralShapeOf(name)?.id ?? null;
  }

  private structuralShapeOf(name: string): ClassShape | null {
    const cached = this.structural.get(name);
    if (cached !== undefined) return cached;
    this.structural.set(name, null);
    const minted = this.mintStructural(name);
    this.structural.set(name, minted);
    return minted;
  }

  private mintStructural(name: string): ClassShape | null {
    const literal = typeLiteralShape(resolveType(name, this.env));
    if (literal === null || literal.fields.size === 0) return null;
    if ((literal.indexers ?? []).length > 0) return null;
    const fields: LiteralField[] = [];
    for (const [field, binding] of literal.fields) {
      if (binding.optional) return null;
      fields.push({ name: field, declaredType: String(binding.type) });
    }
    const shape = this.defineSynthetic(literalShapeSurface(fields));
    return shape.fields.size === fields.length ? shape : null;
  }

  private lookup(name: string): ClassShape | undefined {
    const exact = this.byName.get(name);
    if (exact !== undefined) return exact;
    const spelled = splitCellKey(name);
    return spelled.module === null ? undefined : this.byName.get(spelled.name);
  }

  shapeOf(name: string): ClassShape | null {
    return this.lookup(name) ?? null;
  }

  shapeById(id: number): ClassShape | null {
    return this.byId.get(id) ?? null;
  }

  shapes(): readonly ClassShape[] {
    return [...this.byId.values()].sort((left, right) => left.id - right.id);
  }

  dispatchConeOf(name: string): readonly ClassShape[] {
    const cached = this.cones.get(name);
    if (cached !== undefined) return cached;
    const shape = this.lookup(name);
    if (shape === undefined) return [];
    const cone = this.conformingShapes(shape);
    this.cones.set(name, cone);
    return cone;
  }

  implementationsOf(
    name: string,
    member: string,
    kind: ClassCallableKind,
  ): readonly ClassMethod[] {
    const seen = new Set<string>();
    const targets: ClassMethod[] = [];
    for (const shape of this.dispatchConeOf(name)) {
      if (shape.abstract) continue;
      const target = callableOf(shape.callables, kind, member);
      if (target === null || target.abstract || seen.has(target.symbol)) continue;
      seen.add(target.symbol);
      targets.push(target);
    }
    return targets;
  }

  declareThrownType(declaredType: string): void {
    this.thrown = declaredType;
  }

  thrownType(): string | null {
    return this.thrown;
  }

  declareGlobal(name: string, declaredType: string): GlobalVariable | null {
    const existing = this.globalVariables.get(name);
    if (existing !== undefined) {
      return existing.declaredType === declaredType ? existing : null;
    }
    const scalar = fieldScalarOf(declaredType, this);
    if (scalar === null) return null;
    const offset = this.reserveStatic(globalVariableSymbol(name), scalar);
    if (offset === null) return null;
    const variable: GlobalVariable = { name, declaredType, offset, scalar };
    this.globalVariables.set(name, variable);
    return variable;
  }

  retypeField(owner: string, name: string, declaredType: string): boolean {
    const shape = this.lookup(owner);
    if (shape === undefined) return false;
    const instance = shape.fields.get(name);
    const held = instance ?? shape.staticFields.get(name);
    if (held === undefined || held.declaredType === declaredType) return false;
    if (fieldScalarOf(declaredType, this) !== held.scalar) return false;
    if (instance === undefined) {
      (shape.staticFields as Map<string, ClassStaticField>).set(name, {
        ...(held as ClassStaticField),
        declaredType,
      });
    } else {
      (shape.fields as Map<string, ClassField>).set(name, { ...instance, declaredType });
    }
    return true;
  }

  declareStaticField(owner: string, name: string, declaredType: string): boolean {
    const shape = this.lookup(owner);
    if (shape === undefined || shape.staticFields.has(name)) return false;
    const scalar = fieldScalarOf(declaredType, this);
    if (scalar === null) return false;
    const symbol = classStaticFieldSymbol(owner, name);
    const offset = this.reserveStatic(symbol, scalar);
    if (offset === null) return false;
    (shape.staticFields as Map<string, ClassStaticField>).set(name, {
      name,
      owner,
      symbol,
      declaredType,
      offset,
      scalar,
    });
    return true;
  }

  globalOf(name: string): GlobalVariable | null {
    return this.globalVariables.get(name) ?? null;
  }

  globals(): readonly GlobalVariable[] {
    return [...this.globalVariables.values()];
  }

  declareGenerator(producer: string, generator: GeneratorShape): void {
    this.generatorShapes.set(producer, generator);
  }

  generatorOf(producer: string): GeneratorShape | null {
    return this.generatorShapes.get(producer) ?? null;
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
      tailReferences: false,
      constructorSymbol: surface.name,
      constructorSignature: {
        params: [surface.name, ...surface.constructorParams],
        returns: surface.name,
      },
      constructorParamNames: surface.constructorParamNames,
      unsupported,
    };
    this.adopt(shape);
  }

  private adopt(shape: ClassShape): void {
    this.byName.set(shape.name, shape);
    this.byId.set(shape.id, shape);
    this.index(shape);
  }

  private index(shape: ClassShape): void {
    const carriedBy = shape.abstract ? this.abstractByMember : this.byMember;
    for (const member of memberNamesOf(shape)) {
      const carriers = carriedBy.get(member);
      if (carriers === undefined) carriedBy.set(member, [shape]);
      else carriers.push(shape);
    }
  }

  standInsFor(shape: ClassShape): readonly ClassShape[] {
    const cached = this.standIns.get(shape.name);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const carried: ClassShape[] = [];
    for (const member of memberNamesOf(shape)) {
      for (const candidate of this.abstractByMember.get(member) ?? []) {
        if (seen.has(candidate.name)) continue;
        seen.add(candidate.name);
        if (conformsTo(shape, candidate)) carried.push(candidate);
      }
    }
    this.standIns.set(shape.name, carried);
    return carried;
  }

  private conformingShapes(shape: ClassShape): readonly ClassShape[] {
    const required = memberNamesOf(shape);
    let candidates: readonly ClassShape[] | null = null;
    for (const member of required) {
      const carriers = this.byMember.get(member) ?? [];
      if (candidates === null || carriers.length < candidates.length) candidates = carriers;
    }
    if (candidates === null) return shape.abstract ? [] : [shape];
    return candidates.filter((candidate) => conformsTo(candidate, shape));
  }
}

function memberNamesOf(shape: ClassShape): readonly string[] {
  const names = new Set<string>(shape.fields.keys());
  for (const kind of CLASS_CALLABLE_KINDS) {
    for (const name of shape.callables.get(kind)?.keys() ?? []) names.add(name);
  }
  return [...names];
}

function conformsTo(candidate: ClassShape, required: ClassShape): boolean {
  for (const field of required.fields.values()) {
    const carried = candidate.fields.get(field.name);
    if (carried === undefined) return false;
    if (carried.offset !== field.offset || carried.scalar !== field.scalar) return false;
  }
  for (const kind of CLASS_CALLABLE_KINDS) {
    const members = required.callables.get(kind);
    if (members === undefined) continue;
    const carried = candidate.callables.get(kind);
    for (const [name, method] of members) {
      const found = carried?.get(name);
      if (found === undefined) return false;
      if (found.signature.params.length !== method.signature.params.length) return false;
    }
  }
  return true;
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

export function buildClassTable(
  surfaces: readonly ClassSurface[],
  env?: TypeEnv,
): ClassTable {
  return new Table(surfaces, env);
}

export const ITERATOR_MEMBER = "@@iterator";
export const STEP_MEMBER = "next";

export function carriesMember(shape: ClassShape, name: string): boolean {
  if (shape.fields.has(name)) return true;
  for (const members of shape.callables.values()) {
    if (members.has(name)) return true;
  }
  return false;
}

function answeredTypeName(declaredType: string): string {
  const arrow = declaredType.lastIndexOf(SIGNATURE_ARROW);
  const answered = arrow < 0 ? declaredType : declaredType.slice(arrow + SIGNATURE_ARROW.length);
  return answered.trim();
}

function iteratorHookAnswers(shape: ClassShape): string | null {
  const held = shape.fields.get(ITERATOR_MEMBER);
  if (held !== undefined) return answeredTypeName(held.declaredType);
  for (const members of shape.callables.values()) {
    const hook = members.get(ITERATOR_MEMBER);
    if (hook !== undefined) return hook.signature.returns;
  }
  return null;
}

export function stepsItself(shape: ClassShape): boolean {
  if (!carriesMember(shape, STEP_MEMBER)) return false;
  return iteratorHookAnswers(shape) === shape.name;
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

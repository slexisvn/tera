import {
  arrayElementType,
  builtinMethod,
  cleanType,
  createTypeEnv,
  isTupleType,
  removeNullish,
  tupleTypes,
  unionParts,
  type TypeEnv,
} from "../../frontend/checker/type-system.js";
import { elementsKindFor } from "./elements.js";
import type { DeclaredSignature } from "./signature.js";
import {
  anyType,
  arrayType,
  booleanType,
  doubleType,
  joinTypes,
  nullishType,
  objectType,
  smiType,
  stringType,
  TypeKind,
  type LatticeType,
} from "./lattice.js";

export interface NominalTypes {
  shapeIdOf(name: string): number | null;
}

const NO_NOMINAL_TYPES: NominalTypes = { shapeIdOf: () => null };

export const DECLARED_INT = "int";

const PRIMITIVE_TYPES = new Map<string, LatticeType>([
  [DECLARED_INT, smiType()],
  ["float", doubleType()],
  ["bool", booleanType()],
  ["boolean", booleanType()],
  ["string", stringType()],
  ["null", nullishType()],
  ["undefined", nullishType()],
  ["void", nullishType()],
]);

let sharedEnv: TypeEnv | null = null;

export function builtinTypeEnv(): TypeEnv {
  if (sharedEnv === null) sharedEnv = createTypeEnv();
  return sharedEnv;
}

function joinAll(types: readonly LatticeType[]): LatticeType {
  let joined: LatticeType | null = null;
  for (const type of types) joined = joinTypes(joined, type);
  return joined ?? anyType();
}

function classifyAtom(resolved: string, env: TypeEnv, nominal: NominalTypes): LatticeType {
  const primitive = PRIMITIVE_TYPES.get(resolved);
  if (primitive !== undefined) return primitive;

  const element = arrayElementType(resolved);
  if (element !== null) {
    return arrayType(elementsKindFor(latticeFromDeclaredType(element, env, nominal)));
  }

  if (isTupleType(resolved)) {
    const items = tupleTypes(resolved).map((item) => latticeFromDeclaredType(item, env, nominal));
    return arrayType(elementsKindFor(joinAll(items)));
  }

  const shapeId = nominal.shapeIdOf(resolved);
  if (shapeId !== null) return objectType(shapeId);

  return anyType();
}

const memo = new WeakMap<TypeEnv, WeakMap<NominalTypes, Map<string, LatticeType>>>();

function memoFor(env: TypeEnv, nominal: NominalTypes): Map<string, LatticeType> {
  let byNominal = memo.get(env);
  if (byNominal === undefined) {
    byNominal = new WeakMap<NominalTypes, Map<string, LatticeType>>();
    memo.set(env, byNominal);
  }
  let cache = byNominal.get(nominal);
  if (cache === undefined) {
    cache = new Map<string, LatticeType>();
    byNominal.set(nominal, cache);
  }
  return cache;
}

export function latticeFromDeclaredType(
  source: string | null | undefined,
  env: TypeEnv = builtinTypeEnv(),
  nominal: NominalTypes = NO_NOMINAL_TYPES,
): LatticeType {
  if (source === null || source === undefined) return anyType();
  const cleaned = cleanType(source);
  if (cleaned.length === 0) return anyType();
  const cache = memoFor(env, nominal);
  const cached = cache.get(cleaned);
  if (cached !== undefined) return cached;
  const parts = unionParts(cleaned, env);
  const result =
    parts.length === 1
      ? classifyAtom(parts[0]!, env, nominal)
      : joinAll(parts.map((part) => classifyAtom(part, env, nominal)));
  cache.set(cleaned, result);
  return result;
}

export function declaredAcceptsNull(
  source: string | null | undefined,
  env: TypeEnv = builtinTypeEnv(),
): boolean {
  if (source === null || source === undefined) return false;
  const cleaned = cleanType(source);
  if (cleaned.length === 0) return false;
  const parts = unionParts(cleaned, env);
  if (parts.length < 2) return false;
  return parts.some((part) => PRIMITIVE_TYPES.get(part)?.kind === TypeKind.Nullish);
}

export function presentTypeName(
  source: string | null | undefined,
  env: TypeEnv = builtinTypeEnv(),
): string {
  if (source === null || source === undefined) return "";
  return removeNullish(cleanType(source), env);
}

export function nominalLatticeType(
  source: string | null | undefined,
  nominal: NominalTypes | null,
): LatticeType {
  return latticeFromDeclaredType(source, builtinTypeEnv(), nominal ?? NO_NOMINAL_TYPES);
}

export type { DeclaredSignature };

const CHECKER_NAME_BY_KIND = new Map<string, string>([
  [TypeKind.String, "string"],
  [TypeKind.Smi, DECLARED_INT],
  [TypeKind.Double, "float"],
  [TypeKind.Number, "float"],
  [TypeKind.Boolean, "bool"],
  [TypeKind.Array, "Array"],
]);

export interface BuiltinMemberType {
  readonly type: LatticeType;
  readonly getter: boolean;
  readonly requiredCount: number;
  readonly signature: DeclaredSignature;
}

export function declaredNameOf(receiver: LatticeType): string | null {
  return CHECKER_NAME_BY_KIND.get(receiver.kind) ?? null;
}

export function builtinOwnerMember(
  owner: string,
  name: string,
  env: TypeEnv = builtinTypeEnv(),
): BuiltinMemberType | null {
  const member = builtinMethod(owner, name, env);
  if (member === null) return null;
  const { params, positional, required } = member.signature;
  return {
    type: latticeFromDeclaredType(member.returns, env),
    getter: member.getter,
    requiredCount: positional.filter((param) => required.has(param)).length,
    signature: {
      params: positional.map((param) => params.get(param)?.type ?? null),
      returns: member.returns,
    },
  };
}

export function builtinMemberType(
  receiver: LatticeType,
  name: string,
  env: TypeEnv = builtinTypeEnv(),
): BuiltinMemberType | null {
  const owner = declaredNameOf(receiver);
  return owner === null ? null : builtinOwnerMember(owner, name, env);
}

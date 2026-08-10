import {
  arrayElementType,
  builtinMethod,
  cleanType,
  createTypeEnv,
  isTupleType,
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
  smiType,
  stringType,
  TypeKind,
  type LatticeType,
} from "./lattice.js";

const PRIMITIVE_TYPES = new Map<string, LatticeType>([
  ["int", smiType()],
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

function classifyAtom(resolved: string, env: TypeEnv): LatticeType {
  const primitive = PRIMITIVE_TYPES.get(resolved);
  if (primitive !== undefined) return primitive;

  const element = arrayElementType(resolved);
  if (element !== null) {
    return arrayType(elementsKindFor(latticeFromDeclaredType(element, env)));
  }

  if (isTupleType(resolved)) {
    const items = tupleTypes(resolved).map((item) => latticeFromDeclaredType(item, env));
    return arrayType(elementsKindFor(joinAll(items)));
  }

  return anyType();
}

const memo = new WeakMap<TypeEnv, Map<string, LatticeType>>();

function memoFor(env: TypeEnv): Map<string, LatticeType> {
  let cache = memo.get(env);
  if (cache === undefined) {
    cache = new Map<string, LatticeType>();
    memo.set(env, cache);
  }
  return cache;
}

export function latticeFromDeclaredType(
  source: string | null | undefined,
  env: TypeEnv = builtinTypeEnv(),
): LatticeType {
  if (source === null || source === undefined) return anyType();
  const cleaned = cleanType(source);
  if (cleaned.length === 0) return anyType();
  const cache = memoFor(env);
  const cached = cache.get(cleaned);
  if (cached !== undefined) return cached;
  const parts = unionParts(cleaned, env);
  const result =
    parts.length === 1
      ? classifyAtom(parts[0]!, env)
      : joinAll(parts.map((part) => classifyAtom(part, env)));
  cache.set(cleaned, result);
  return result;
}

export type { DeclaredSignature };

const CHECKER_NAME_BY_KIND = new Map<string, string>([
  [TypeKind.String, "string"],
  [TypeKind.Smi, "int"],
  [TypeKind.Double, "float"],
  [TypeKind.Number, "float"],
  [TypeKind.Boolean, "bool"],
  [TypeKind.Array, "Array"],
]);

export interface BuiltinMemberType {
  readonly type: LatticeType;
  readonly getter: boolean;
  readonly signature: DeclaredSignature;
}

export function builtinOwnerName(receiver: LatticeType): string | null {
  return CHECKER_NAME_BY_KIND.get(receiver.kind) ?? null;
}

export function builtinOwnerMember(
  owner: string,
  name: string,
  env: TypeEnv = builtinTypeEnv(),
): BuiltinMemberType | null {
  const member = builtinMethod(owner, name, env);
  if (member === null) return null;
  const { params, positional } = member.signature;
  return {
    type: latticeFromDeclaredType(member.returns, env),
    getter: member.getter,
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
  const owner = builtinOwnerName(receiver);
  return owner === null ? null : builtinOwnerMember(owner, name, env);
}

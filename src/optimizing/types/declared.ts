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

export type { DeclaredSignature } from "./signature.js";

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
}

export function builtinMemberType(
  receiver: LatticeType,
  name: string,
  env: TypeEnv = builtinTypeEnv(),
): BuiltinMemberType | null {
  const typeName = CHECKER_NAME_BY_KIND.get(receiver.kind);
  if (typeName === undefined) return null;
  const member = builtinMethod(typeName, name, env);
  if (member === null) return null;
  return {
    type: latticeFromDeclaredType(member.returns, env),
    getter: member.getter,
  };
}

import * as ir from "../ir/index.js";
import { builtinOwnerMember, builtinOwnerName } from "../types/declared.js";
import type { LatticeType } from "../types/lattice.js";
import type { DeclaredSignature } from "../types/signature.js";

export interface BuiltinMethodIntrinsic {
  readonly owner: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly argCount: number;
  readonly getter: boolean;
  readonly signature: DeclaredSignature;
  readonly pure: boolean;
}

type BuiltinMethodDeclaration = {
  readonly owner: string;
  readonly name: string;
  readonly pure: boolean;
};

export const BUILTIN_METHOD_DECLARATIONS: readonly BuiltinMethodDeclaration[] = [
  { owner: "string", name: "char_code_at", pure: true },
  { owner: "string", name: "length", pure: true },
];

export const BUILTIN_NAMESPACE = "Math";

type NamespaceFunctionDeclaration = {
  readonly name: string;
  readonly argCount: number;
};

const NAMESPACE_FUNCTION_DECLARATIONS: readonly NamespaceFunctionDeclaration[] = [
  { name: "abs", argCount: 1 },
  { name: "floor", argCount: 1 },
  { name: "ceil", argCount: 1 },
  { name: "sqrt", argCount: 1 },
  { name: "trunc", argCount: 1 },
  { name: "round", argCount: 1 },
  { name: "min", argCount: 2 },
  { name: "max", argCount: 2 },
];

export function qualifiedMethodName(owner: string, name: string): string {
  return `${owner}.${name}`;
}

function buildNamespaceRegistry(): Map<string, BuiltinMethodIntrinsic> {
  const registry = new Map<string, BuiltinMethodIntrinsic>();
  for (const declaration of NAMESPACE_FUNCTION_DECLARATIONS) {
    const qualifiedName = qualifiedMethodName(BUILTIN_NAMESPACE, declaration.name);
    registry.set(qualifiedName, {
      owner: BUILTIN_NAMESPACE,
      name: declaration.name,
      qualifiedName,
      argCount: declaration.argCount,
      getter: false,
      signature: {
        params: Array.from({ length: declaration.argCount }, () => "float"),
        returns: "float",
      },
      pure: true,
    });
  }
  return registry;
}

const NAMESPACE_REGISTRY = buildNamespaceRegistry();

export function builtinNamespaceIntrinsic(
  namespace: string,
  name: string,
  argCount: number,
): BuiltinMethodIntrinsic | null {
  if (namespace !== BUILTIN_NAMESPACE) return null;
  const intrinsic = NAMESPACE_REGISTRY.get(qualifiedMethodName(namespace, name)) ?? null;
  return intrinsic === null || intrinsic.argCount !== argCount ? null : intrinsic;
}

export function builtinNamespaceIntrinsicByName(
  qualifiedName: string,
): BuiltinMethodIntrinsic | null {
  return NAMESPACE_REGISTRY.get(qualifiedName) ?? null;
}

function buildRegistry(): Map<string, BuiltinMethodIntrinsic> {
  const registry = new Map<string, BuiltinMethodIntrinsic>();
  for (const declaration of BUILTIN_METHOD_DECLARATIONS) {
    const member = builtinOwnerMember(declaration.owner, declaration.name);
    if (member === null) continue;
    const qualifiedName = qualifiedMethodName(declaration.owner, declaration.name);
    const params = member.getter ? [] : member.signature.params;
    registry.set(qualifiedName, {
      owner: declaration.owner,
      name: declaration.name,
      qualifiedName,
      argCount: params.length + 1,
      getter: member.getter,
      signature: {
        params: [declaration.owner, ...params],
        returns: member.signature.returns,
      },
      pure: declaration.pure,
    });
  }
  return registry;
}

const REGISTRY = buildRegistry();

export function builtinMethodIntrinsicByName(
  qualifiedName: string,
): BuiltinMethodIntrinsic | null {
  return REGISTRY.get(qualifiedName) ?? null;
}

export function builtinIntrinsicByName(
  qualifiedName: string,
): BuiltinMethodIntrinsic | null {
  return builtinMethodIntrinsicByName(qualifiedName) ?? builtinNamespaceIntrinsicByName(qualifiedName);
}

export function builtinMethodIntrinsicFor(
  receiver: LatticeType,
  name: string,
): BuiltinMethodIntrinsic | null {
  const owner = builtinOwnerName(receiver);
  return owner === null ? null : builtinMethodIntrinsicByName(qualifiedMethodName(owner, name));
}

export function builtinMethodCallMetadata(
  intrinsic: BuiltinMethodIntrinsic,
): ir.IRMetadata {
  const props: ir.IRMetadata = {
    builtin: true,
    target: {
      declaredSignature: {
        params: [...intrinsic.signature.params],
        returns: intrinsic.signature.returns,
      },
    },
  };
  if (intrinsic.pure) {
    props.declaredEffects = ["immutable-read"];
    props.readonly = true;
  }
  return props;
}

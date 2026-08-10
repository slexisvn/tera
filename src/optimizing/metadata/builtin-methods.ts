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

export function qualifiedMethodName(owner: string, name: string): string {
  return `${owner}.${name}`;
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
    props.effectKind = ir.EFFECT_READ;
    props.pure = true;
    props.readonly = true;
  }
  return props;
}

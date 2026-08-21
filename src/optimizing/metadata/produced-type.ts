import { IR_CALL_BUILTIN, type CFGInstruction } from "../ir/index.js";
import { nominalLatticeType, type NominalTypes } from "../types/declared.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";
import type { DeclaredSignature } from "../types/signature.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { builtinIntrinsicByName } from "./builtin-methods.js";

function declaredReturnOf(value: CFGInstruction): string | null {
  if (value.type === IR_CALL_BUILTIN) {
    return builtinIntrinsicByName(String(value.props.name))?.signature.returns ?? null;
  }
  const target = value.props.target as { declaredSignature?: DeclaredSignature } | undefined;
  return target?.declaredSignature?.returns ?? null;
}

export function producedType(
  value: CFGInstruction,
  types: TypeInference,
  classes: NominalTypes | null,
): LatticeType {
  const inferred = types.typeOf(value);
  if (inferred.kind !== TypeKind.Never) return inferred;
  const returns = declaredReturnOf(value);
  return returns === null ? inferred : nominalLatticeType(returns, classes);
}

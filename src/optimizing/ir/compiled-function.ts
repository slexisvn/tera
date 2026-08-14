import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import type { IRMetadataValue } from "./index.js";

export function compiledFunctionConstant(
  value: IRMetadataValue,
): RegisterCompiledFunction | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { instructions?: unknown; paramCount?: unknown };
  const looksCompiled =
    Array.isArray(candidate.instructions) && typeof candidate.paramCount === "number";
  return looksCompiled ? (value as RegisterCompiledFunction) : null;
}

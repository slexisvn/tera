import { isUnwrittenType } from "../../core/type-text.js";

export type DeclaredDefault = number | string | boolean | null;

const SIGNATURE_ARROW = "->";
const GATHERED_PARAMETER_PREFIX = "gathered$";

function topLevelParts(source: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < source.length; at++) {
    const character = source[at]!;
    if (character === "(" || character === "[" || character === "<") depth++;
    else if (character === ")" || character === "]" || character === ">") depth--;
    else if (character === "," && depth === 0) {
      parts.push(source.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function functionSignatureOf(declared: string | null | undefined): DeclaredSignature | null {
  if (typeof declared !== "string") return null;
  const source = declared.trim();
  if (!source.startsWith("(")) return null;
  let depth = 0;
  for (let at = 0; at < source.length; at++) {
    const character = source[at]!;
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth > 0) continue;
      const rest = source.slice(at + 1).trim();
      if (!rest.startsWith(SIGNATURE_ARROW)) return null;
      return {
        params: topLevelParts(source.slice(1, at)),
        returns: rest.slice(SIGNATURE_ARROW.length).trim(),
      };
    }
  }
  return null;
}

export const isUnwritten = isUnwrittenType;

export interface RestParameter {
  readonly name: string;
  readonly type: string | null;
}

export interface DeclaredSignature {
  readonly params: readonly (string | null)[];
  readonly names?: readonly string[];
  readonly defaults?: readonly (DeclaredDefault | undefined)[];
  readonly variadic?: boolean;
  readonly rest?: RestParameter | null;
  readonly returns: string | null;
}

export function functionTypeTextOf(signature: DeclaredSignature | null | undefined): string | null {
  if (signature === null || signature === undefined) return null;
  if (signature.variadic === true || signature.rest != null) return null;
  const params: string[] = [];
  for (const param of signature.params) {
    if (typeof param !== "string" || isUnwrittenType(param)) return null;
    params.push(param);
  }
  const returns = signature.returns;
  if (typeof returns !== "string" || isUnwrittenType(returns)) return null;
  return `(${params.join(", ")}) ${SIGNATURE_ARROW} ${returns}`;
}

export function gatheredParameterName(at: number): string {
  return `${GATHERED_PARAMETER_PREFIX}${at}`;
}

export function isGatheredParameter(name: string | undefined): boolean {
  return name !== undefined && name.startsWith(GATHERED_PARAMETER_PREFIX);
}

export interface ParameterLabel {
  readonly name: string | null;
  readonly gathered: boolean;
}

export function parameterLabelOf(
  signature: DeclaredSignature | null | undefined,
  index: number,
): ParameterLabel {
  const name = signature?.names?.[index];
  if (!isGatheredParameter(name)) return { name: name ?? null, gathered: false };
  return { name: signature?.rest?.name ?? name!, gathered: true };
}

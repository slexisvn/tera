export type DeclaredDefault = number | string | boolean | null;

const SIGNATURE_ARROW = "->";
const ANY_TYPE = "any";

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

export function isUnwritten(declared: string | null | undefined): boolean {
  return declared === null || declared === undefined || declared.trim() === ANY_TYPE;
}

export interface DeclaredSignature {
  readonly params: readonly (string | null)[];
  readonly names?: readonly string[];
  readonly defaults?: readonly (DeclaredDefault | undefined)[];
  readonly variadic?: boolean;
  readonly returns: string | null;
}

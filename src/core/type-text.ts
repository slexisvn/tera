export function splitTopLevel(source: string, separator: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ">" && source[i - 1] !== "-") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === separator) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

const UNWRITTEN_TYPE = "any";

export const UNTYPED_NAMES: ReadonlySet<string> = new Set([
  UNWRITTEN_TYPE,
  "unknown",
  "undefined",
  "void",
  "never",
]);

export function isUnwrittenType(declared: string | null | undefined): boolean {
  return declared === null || declared === undefined || declared.trim() === UNWRITTEN_TYPE;
}

export function isUntypedName(declared: string | null | undefined): boolean {
  return declared === null || declared === undefined || UNTYPED_NAMES.has(declared.trim());
}

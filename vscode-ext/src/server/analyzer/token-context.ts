import type { AnalyzedToken, Position } from "./types.ts";

export function tokenIndexStartingAt(tokens: readonly AnalyzedToken[], position: Position): number {
  return tokens.findIndex((token) =>
    token.line === position.line + 1 && token.column === position.character + 1
  );
}

export function isObjectKeyAt(tokens: readonly AnalyzedToken[], position: Position): boolean {
  const index = tokenIndexStartingAt(tokens, position);
  return index >= 0 && isObjectKeyToken(tokens, index);
}

export function objectKeyPositionSet(tokens: readonly AnalyzedToken[]): ReadonlySet<string> {
  const positions = new Set<string>();
  const stack: AnalyzedToken[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === "identifier" && stack.at(-1)?.value === "{" && hasKeyDelimiter(tokens, index)) {
      positions.add(positionKey(token));
    }
    if (token.value === "{" || token.value === "[" || token.value === "(") {
      stack.push(token);
    } else if (token.value === "}" || token.value === "]" || token.value === ")") {
      popDelimiter(stack, token.value);
    }
  }
  return positions;
}

export function isObjectKeyToken(tokens: readonly AnalyzedToken[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined || token.type !== "identifier") return false;
  return hasKeyDelimiter(tokens, index) && enclosingDelimiter(tokens, index)?.value === "{";
}

export function positionKey(position: Position | Pick<AnalyzedToken, "line" | "column">): string {
  if ("character" in position) return `${position.line + 1}:${position.character + 1}`;
  return `${position.line}:${position.column}`;
}

function nextAfterOptional(tokens: readonly AnalyzedToken[], index: number, optional: string): number {
  return tokens[index]?.value === optional ? index + 1 : index;
}

function hasKeyDelimiter(tokens: readonly AnalyzedToken[], index: number): boolean {
  const next = nextAfterOptional(tokens, index + 1, "?");
  return tokens[next]?.value === ":";
}

function enclosingDelimiter(tokens: readonly AnalyzedToken[], before: number): AnalyzedToken | null {
  const stack: AnalyzedToken[] = [];
  for (let i = 0; i < before; i++) {
    const value = tokens[i]!.value;
    if (value === "{" || value === "[" || value === "(") stack.push(tokens[i]!);
    else if (value === "}" || value === "]" || value === ")") popDelimiter(stack, value);
  }
  return stack.at(-1) ?? null;
}

function popDelimiter(stack: AnalyzedToken[], close: string): void {
  const open = close === "}" ? "{" : close === "]" ? "[" : "(";
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame?.value === open) return;
  }
}

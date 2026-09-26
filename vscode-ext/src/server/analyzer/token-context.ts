import { astChildren, NodeType, type ASTNode } from "tera/frontend";
import type { AnalyzedToken, Position } from "./types.ts";

export function tokenIndexStartingAt(tokens: readonly AnalyzedToken[], position: Position): number {
  return tokens.findIndex((token) =>
    token.line === position.line + 1 && token.column === position.character + 1
  );
}

export function isNonReferenceIdentifierAt(tokens: readonly AnalyzedToken[], position: Position, ast?: unknown): boolean {
  const index = tokenIndexStartingAt(tokens, position);
  if (index < 0) return false;
  return nonReferenceIdentifierPositionSet(tokens, ast).has(positionKey(position));
}

export function nonReferenceIdentifierPositionSet(tokens: readonly AnalyzedToken[], ast?: unknown): ReadonlySet<string> {
  return new Set([...objectKeyPositionSet(tokens), ...namedArgumentPositionSet(ast)]);
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

export function positionKey(position: Position | Pick<AnalyzedToken, "line" | "column">): string {
  if ("character" in position) return `${position.line + 1}:${position.character + 1}`;
  return `${position.line}:${position.column}`;
}

function namedArgumentPositionSet(ast: unknown): ReadonlySet<string> {
  const positions = new Set<string>();
  if (!isAstNode(ast)) return positions;

  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node.type === NodeType.NamedArgument &&
      typeof node.name === "string" &&
      typeof node.__line === "number" &&
      typeof node.__column === "number"
    ) {
      positions.add(`${node.__line}:${node.__column}`);
    }
    stack.push(...astChildren(node));
  }
  return positions;
}

function isAstNode(value: unknown): value is ASTNode {
  return !!value && typeof value === "object" && "type" in value;
}

function nextAfterOptional(tokens: readonly AnalyzedToken[], index: number, optional: string): number {
  return tokens[index]?.value === optional ? index + 1 : index;
}

function hasKeyDelimiter(tokens: readonly AnalyzedToken[], index: number): boolean {
  const next = nextAfterOptional(tokens, index + 1, "?");
  return tokens[next]?.value === ":";
}

function popDelimiter(stack: AnalyzedToken[], close: string): void {
  const open = close === "}" ? "{" : close === "]" ? "[" : "(";
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame?.value === open) return;
  }
}

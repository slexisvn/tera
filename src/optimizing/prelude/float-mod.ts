import { NodeType, nodesMatching, type ASTNode } from "../../frontend/ast/index.js";

export const FLOAT_MOD_FN = "_float_mod";

const REMAINDER = "%";

const TAKES_REMAINDER: ReadonlySet<string> = new Set<string>([
  NodeType.BinaryExpression,
  NodeType.CompoundAssignmentExpression,
]);

function usesRemainder(roots: readonly ASTNode[]): boolean {
  return (
    nodesMatching(roots, (node) => TAKES_REMAINDER.has(node.type) && node.op === REMAINDER)
      .length > 0
  );
}

function source(): readonly string[] {
  return [
    `fn ${FLOAT_MOD_FN}(left: float, right: float) -> float:`,
    "  divisor: float = right",
    "  if divisor < 0.0:",
    "    divisor = 0.0 - divisor",
    "  rest: float = left",
    "  negative: bool = false",
    "  if rest < 0.0:",
    "    negative = true",
    "    rest = 0.0 - rest",
    "  undefined_here: float = (left - left) / (right - right)",
    "  if divisor == 0.0 or rest != rest or divisor != divisor:",
    "    return undefined_here",
    "  if rest < divisor:",
    "    if negative:",
    "      return 0.0 - rest",
    "    return rest",
    "  if rest == rest / 2.0:",
    "    return undefined_here",
    "  step: float = divisor",
    "  while step <= rest / 2.0:",
    "    step = step * 2.0",
    "  while step >= divisor:",
    "    if rest >= step:",
    "      rest = rest - step",
    "    step = step / 2.0",
    "  if negative:",
    "    return 0.0 - rest",
    "  return rest",
  ];
}

export function floatModPrelude(roots: readonly ASTNode[]): string {
  return usesRemainder(roots) ? `${source().join("\n")}\n\n` : "";
}

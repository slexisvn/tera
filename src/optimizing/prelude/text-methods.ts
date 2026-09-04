import {
  astChildren,
  Identifier,
  Literal,
  nodesMatching,
  NodeType,
  type ASTNode,
} from "../../frontend/ast/index.js";
import { STRING_TO_END } from "../metadata/builtin-methods.js";

export interface TextMethod {
  readonly member: string;
  readonly fn: string;
  readonly arity: number;
  readonly defaults: readonly number[];
  readonly sharedName: boolean;
  readonly source: readonly string[];
}

const substring: TextMethod = {
  member: "substring",
  fn: "_text_substring",
  arity: 2,
  defaults: [0, STRING_TO_END],
  sharedName: false,
  source: [
    "fn _text_substring(s: string, a: int, b: int) -> string:",
    "  n: int = s.length",
    "  x: int = a",
    "  if x < 0:",
    "    x = 0",
    "  if x > n:",
    "    x = n",
    "  y: int = b",
    "  if y < 0:",
    "    y = 0",
    "  if y > n:",
    "    y = n",
    "  if x > y:",
    "    return s.slice(y, x)",
    "  return s.slice(x, y)",
  ],
};

const lastIndexOf: TextMethod = {
  member: "last_index_of",
  fn: "_text_last_index_of",
  arity: 1,
  defaults: [],
  sharedName: true,
  source: [
    "fn _text_last_index_of(s: string, sub: string) -> int:",
    "  n: int = s.length",
    "  m: int = sub.length",
    "  if m > n:",
    "    return 0 - 1",
    "  start: int = n - m",
    "  while start >= 0:",
    "    at: int = 0",
    "    while at < m and s.char_code_at(start + at) == sub.char_code_at(at):",
    "      at = at + 1",
    "    if at == m:",
    "      return start",
    "    start = start - 1",
    "  return 0 - 1",
  ],
};

export const TEXT_METHODS: readonly TextMethod[] = [substring, lastIndexOf];

const BY_MEMBER: ReadonlyMap<string, TextMethod> = new Map(
  TEXT_METHODS.map((method) => [method.member, method]),
);

export function textMethodNamed(member: string): TextMethod | null {
  return BY_MEMBER.get(member) ?? null;
}

function methodCalled(node: ASTNode): TextMethod | null {
  if (node === null || node === undefined) return null;
  if (node.type !== NodeType.CallExpression) return null;
  const callee = node.callee as ASTNode | undefined;
  if (callee === undefined || callee.type !== NodeType.MemberExpression) return null;
  if (callee.computed === true) return null;
  const method = BY_MEMBER.get(String(callee.property));
  if (method === undefined) return null;
  const given = (node.args as ASTNode[]) ?? [];
  return given.length <= method.arity ? method : null;
}

function declaredMembersIn(node: ASTNode, found: Set<string>): Set<string> {
  if (node === null || node === undefined) return found;
  if (node.type === NodeType.ClassDeclaration) {
    for (const method of (node.methods ?? []) as { name?: string | null }[]) {
      if (method.name !== null && method.name !== undefined) found.add(String(method.name));
    }
  }
  for (const child of astChildren(node)) declaredMembersIn(child, found);
  return found;
}

function declaredMembers(roots: readonly ASTNode[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const root of roots) declaredMembersIn(root, found);
  return found;
}

function callSites(roots: readonly ASTNode[]): readonly ASTNode[] {
  return nodesMatching(roots, (node) => methodCalled(node) !== null);
}

function rewritableSites(roots: readonly ASTNode[]): readonly ASTNode[] {
  const declared = declaredMembers(roots);
  return callSites(roots).filter((site) => {
    const method = methodCalled(site)!;
    return !method.sharedName && !declared.has(method.member);
  });
}

export function textMethodPrelude(roots: readonly ASTNode[]): string {
  const declared = declaredMembers(roots);
  const wanted = new Set(
    callSites(roots)
      .map((site) => methodCalled(site)!)
      .filter((method) => method.sharedName || !declared.has(method.member)),
  );
  if (wanted.size === 0) return "";
  return `${TEXT_METHODS.filter((method) => wanted.has(method))
    .map((method) => method.source.join("\n"))
    .join("\n\n")}\n`;
}

export function rewriteTextMethods(roots: readonly ASTNode[]): number {
  const sites = rewritableSites(roots);
  for (const site of sites) {
    const method = methodCalled(site)!;
    const callee = site.callee as ASTNode;
    const given = (site.args as ASTNode[]) ?? [];
    const filled = method.defaults
      .slice(given.length)
      .map((value) => Literal(value, "number") as ASTNode);
    site.args = [callee.object as ASTNode, ...given, ...filled];
    site.callee = Identifier(method.fn);
  }
  return sites.length;
}

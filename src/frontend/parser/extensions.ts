import type { ASTNode } from "../ast/index.js";
import type { Token, TokenTypeName, TokenValue } from "../lexer/index.js";

export type StatementParseResult = ASTNode | ASTNode[] | null;

export type ParserCheckpoint = {
  readonly position: number;
};

export type SyntaxPlugin = {
  name: string;
  statementStarts?: readonly string[];
  expressionPrefixStarts?: readonly string[];
  expressionInfixStarts?: readonly string[];
  parseStatement?: (context: ParserContext) => StatementParseResult;
  parseExpressionPrefix?: (context: ParserContext) => ASTNode | null;
  parseExpressionInfix?: (context: ParserContext, left: ASTNode, minPrecedence: number) => ASTNode | null;
  transform?: (program: ASTNode, context: SyntaxTransformContext) => ASTNode;
};

export type SyntaxTransformContext = {
  plugin: SyntaxPlugin;
  plugins: readonly SyntaxPlugin[];
};

export type ParserContext = {
  current(): Token;
  peek(offset?: number): Token;
  advance(): Token;
  check(type: TokenTypeName, value?: TokenValue): boolean;
  match(type: TokenTypeName, value?: TokenValue): boolean;
  expect(type: TokenTypeName, value?: TokenValue): Token;
  tokenString(token: Token, context?: string): string;
  parseExpression(minPrecedence?: number): ASTNode;
  parseBlock(): ASTNode;
  parseStatement(): ASTNode | ASTNode[];
  parseStatementBody(): ASTNode | ASTNode[];
  withSpan<T extends ASTNode>(node: T, token: Token | null | undefined): T;
  copySpan<T extends ASTNode>(node: T, source: ASTNode): T;
  checkpoint(): ParserCheckpoint;
  restore(checkpoint: ParserCheckpoint): void;
  error(message: string, token?: Token): never;
};

export type ParserSyntaxOptions = {
  syntaxPlugins?: readonly SyntaxPlugin[];
};

export type SyntaxPluginIndex = {
  statement: Map<string, SyntaxPlugin[]>;
  statementFallback: SyntaxPlugin[];
  prefix: Map<string, SyntaxPlugin[]>;
  prefixFallback: SyntaxPlugin[];
  infix: Map<string, SyntaxPlugin[]>;
  infixFallback: SyntaxPlugin[];
};

function assertPluginName(plugin: SyntaxPlugin): void {
  if (!plugin.name || !/^[A-Za-z0-9_.@/-]+$/.test(plugin.name)) {
    throw new Error(`Invalid syntax plugin name '${plugin.name}'`);
  }
}

function assertStarts(plugin: SyntaxPlugin, starts: readonly string[] | undefined, kind: string): void {
  if (!starts) return;
  const seen = new Set<string>();
  for (const start of starts) {
    if (!start) throw new Error(`Invalid ${kind} start in syntax plugin '${plugin.name}'`);
    if (seen.has(start)) throw new Error(`Duplicate ${kind} start '${start}' in syntax plugin '${plugin.name}'`);
    seen.add(start);
  }
}

function assertHookStarts(plugin: SyntaxPlugin): void {
  if (plugin.statementStarts?.length && !plugin.parseStatement) throw new Error(`Syntax plugin '${plugin.name}' declares statement starts without a statement parser`);
  if (plugin.expressionPrefixStarts?.length && !plugin.parseExpressionPrefix) throw new Error(`Syntax plugin '${plugin.name}' declares prefix starts without a prefix parser`);
  if (plugin.expressionInfixStarts?.length && !plugin.parseExpressionInfix) throw new Error(`Syntax plugin '${plugin.name}' declares infix starts without an infix parser`);
  assertStarts(plugin, plugin.statementStarts, "statement");
  assertStarts(plugin, plugin.expressionPrefixStarts, "prefix");
  assertStarts(plugin, plugin.expressionInfixStarts, "infix");
}

function addIndexed(target: Map<string, SyntaxPlugin[]>, key: string, plugin: SyntaxPlugin): void {
  const bucket = target.get(key);
  if (bucket) bucket.push(plugin);
  else target.set(key, [plugin]);
}

function addStarts(target: Map<string, SyntaxPlugin[]>, fallback: SyntaxPlugin[], starts: readonly string[] | undefined, plugin: SyntaxPlugin): void {
  if (!starts?.length) {
    fallback.push(plugin);
    return;
  }
  for (const start of starts) addIndexed(target, start, plugin);
}

export function normalizeSyntaxPlugins(plugins: readonly SyntaxPlugin[] = []): readonly SyntaxPlugin[] {
  const seen = new Set<string>();
  const normalized: SyntaxPlugin[] = [];
  for (const plugin of plugins) {
    assertPluginName(plugin);
    assertHookStarts(plugin);
    if (seen.has(plugin.name)) throw new Error(`Duplicate syntax plugin '${plugin.name}'`);
    seen.add(plugin.name);
    normalized.push(plugin);
  }
  return normalized;
}

export function buildSyntaxPluginIndex(plugins: readonly SyntaxPlugin[]): SyntaxPluginIndex {
  const index: SyntaxPluginIndex = {
    statement: new Map(),
    statementFallback: [],
    prefix: new Map(),
    prefixFallback: [],
    infix: new Map(),
    infixFallback: [],
  };
  for (const plugin of plugins) {
    if (plugin.parseStatement) addStarts(index.statement, index.statementFallback, plugin.statementStarts, plugin);
    if (plugin.parseExpressionPrefix) addStarts(index.prefix, index.prefixFallback, plugin.expressionPrefixStarts, plugin);
    if (plugin.parseExpressionInfix) addStarts(index.infix, index.infixFallback, plugin.expressionInfixStarts, plugin);
  }
  return index;
}

export function syntaxPluginsFor(map: Map<string, SyntaxPlugin[]>, fallback: readonly SyntaxPlugin[], token: Token): readonly SyntaxPlugin[] {
  const key = typeof token.value === "string" ? token.value : "";
  const exact = key ? map.get(key) : undefined;
  if (!exact?.length) return fallback;
  if (!fallback.length) return exact;
  return [...exact, ...fallback];
}

export function applySyntaxTransforms(program: ASTNode, plugins: readonly SyntaxPlugin[] = []): ASTNode {
  let current = program;
  for (const plugin of plugins) {
    if (!plugin.transform) continue;
    current = plugin.transform(current, { plugin, plugins });
  }
  return current;
}

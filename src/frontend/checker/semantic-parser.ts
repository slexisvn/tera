import { Parser } from "../parser/index.js";
import { Lexer, TokenType, type Token } from "../lexer/index.js";
import type { ASTNode } from "../ast/index.js";
import type {
  BlockNode,
  FunctionNode,
  ForNode,
  InterfaceFieldNode,
  InterfaceNode,
  ModelNode,
  ParameterNode,
  SemanticNode,
  SemanticProgram,
  TypeAliasNode,
} from "./semantic-ast.js";
import { cleanType, splitTopLevel } from "./type-system.js";

type Line = {
  indent: number;
  tokens: Token[];
  text: string;
  line: number;
};

type PositionedNode = ASTNode & {
  __line?: number;
  __column?: number;
};

function leadingIndent(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count++;
  return count;
}

function lineTokens(text: string, line: number, column: number): Token[] {
  return new Lexer(text).tokenize()
    .filter((tok) => tok.type !== TokenType.EOF)
    .map((tok) => ({
      ...tok,
      line,
      column: tok.line === 1 ? column + tok.column - 1 : tok.column,
    }));
}

function delimiterDelta(tokens: Token[]): number {
  let delta = 0;
  for (const tok of tokens) {
    if (tok.type !== TokenType.Punctuator) continue;
    if (tok.value === "(" || tok.value === "[" || tok.value === "{") delta++;
    else if (tok.value === ")" || tok.value === "]" || tok.value === "}") delta--;
  }
  return delta;
}

function tokenText(tokens: Token[]): string {
  return tokens.map((tok) => String(tok.value)).join(" ");
}

function findTopLevel(tokens: Token[], value: string, start = 0): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i];
    if (depth === 0 && tok.value === value) return i;
    if (tok.type === TokenType.Punctuator) {
      if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
      else if (tok.value === ")" || tok.value === "]" || tok.value === "}") depth--;
      if (depth === 0 && tok.value === value) return i;
    }
  }
  return -1;
}

function sliceType(tokens: Token[]): string {
  return cleanType(tokenText(tokens).replace(/\s*\[\s*\]/g, "[]").replace(/\s*<\s*/g, "<").replace(/\s*>\s*/g, ">").replace(/\s*\|\s*/g, " | ").replace(/\s*&\s*/g, " & ").replace(/\s*->\s*/g, " -> "));
}

function parseExpr(tokens: Token[]): ASTNode {
  const parserTokens = [...tokens, { type: TokenType.EOF, value: "", line: tokens.at(-1)?.line ?? 0, column: tokens.at(-1)?.column ?? 0 }];
  const parser = new Parser(parserTokens);
  return annotateExpression(parser.parseExpression(), tokens);
}

function parseExprOrNull(tokens: Token[]): ASTNode | null {
  try {
    return tokens.length ? parseExpr(tokens) : null;
  } catch {
    return null;
  }
}

function parseTypeParams(tokens: Token[], start: number): { params: string[]; next: number } {
  if (tokens[start]?.value !== "<") return { params: [], next: start };
  let depth = 1;
  let end = start + 1;
  while (end < tokens.length && depth > 0) {
    if (tokens[end].value === "<") depth++;
    else if (tokens[end].value === ">") depth--;
    end++;
  }
  return {
    params: splitTopLevel(tokenText(tokens.slice(start + 1, end - 1)), ",").map((part) => part.trim()).filter(Boolean),
    next: end,
  };
}

function parseParams(tokens: Token[]): ParameterNode[] {
  if (tokens.length === 0) return [];
  return splitTopLevel(tokenText(tokens), ",").map((part) => {
    const pieces = part.trim();
    const eq = pieces.indexOf("=");
    const body = eq >= 0 ? pieces.slice(0, eq).trim() : pieces;
    const colon = body.indexOf(":");
    const rawName = colon >= 0 ? body.slice(0, colon).trim() : body;
    const optional = rawName.endsWith("?") || eq >= 0;
    const name = rawName.replace(/\?$/, "");
    const type = colon >= 0 ? cleanType(body.slice(colon + 1)) : "any";
    return { name, type, optional };
  }).filter((param) => param.name);
}

function parseSignature(line: Line, keywordOffset: number): {
  name: string;
  typeParams: string[];
  params: ParameterNode[];
  returns: string;
} | null {
  let cursor = keywordOffset;
  if (line.tokens[cursor]?.value === "async") cursor++;
  if (line.tokens[cursor]?.value === "fn") cursor++;
  if (line.tokens[cursor]?.value === "*") cursor++;
  const nameToken = line.tokens[cursor];
  if (!nameToken || nameToken.type !== TokenType.Identifier) return null;
  cursor++;
  const generic = parseTypeParams(line.tokens, cursor);
  cursor = generic.next;
  if (line.tokens[cursor]?.value !== "(") return null;
  const close = findTopLevel(line.tokens, ")", cursor);
  if (close < 0) return null;
  const params = parseParams(line.tokens.slice(cursor + 1, close));
  const arrow = findTopLevel(line.tokens, "->", close + 1);
  const colon = findTopLevel(line.tokens, ":", close + 1);
  const returns = arrow >= 0 ? sliceType(line.tokens.slice(arrow + 1, colon >= 0 ? colon : line.tokens.length)) : "any";
  return { name: String(nameToken.value), typeParams: generic.params, params, returns };
}

function parseInterfaceField(line: Line): InterfaceFieldNode | null {
  let cursor = line.tokens[0]?.value === "readonly" ? 1 : 0;
  const nameToken = line.tokens[cursor];
  if (!nameToken || nameToken.type !== TokenType.Identifier) return null;
  cursor++;
  const optional = line.tokens[cursor]?.value === "?";
  if (optional) cursor++;
  if (line.tokens[cursor]?.value !== ":") return null;
  return { name: String(nameToken.value), optional, type: sliceType(line.tokens.slice(cursor + 1)) };
}

class SemanticParser {
  lines: Line[];
  index = 0;

  constructor(source: string) {
    const physical = source.replace(/\r\n?/g, "\n").split("\n").flatMap((raw, i) => {
      if (!raw.trim()) return [];
      const indent = leadingIndent(raw);
      const text = raw.slice(indent).trimEnd();
      return [{ indent, text, line: i + 1, tokens: lineTokens(text, i + 1, indent + 1) }];
    });
    this.lines = [];
    for (let i = 0; i < physical.length; i++) {
      const current = physical[i];
      let depth = delimiterDelta(current.tokens);
      while (depth > 0 && i + 1 < physical.length) {
        const next = physical[++i];
        current.text += `\n${next.text}`;
        current.tokens.push(...next.tokens);
        depth += delimiterDelta(next.tokens);
      }
      this.lines.push(current);
    }
  }

  parse(): SemanticProgram {
    return { body: this.parseBlock(-1) };
  }

  parseBlock(parentIndent: number): SemanticNode[] {
    const body: SemanticNode[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line.indent <= parentIndent) break;
      body.push(this.parseNode(line));
    }
    return body;
  }

  parseNode(line: Line): SemanticNode {
    const first = line.tokens[0]?.value;
    if (first === "type") return this.parseTypeAlias(line);
    if (first === "interface") return this.parseInterface(line);
    if (first === "function") return this.parseControlBlock(line, line.tokens.length);
    if (first === "fn" || (first === "async" && line.tokens[1]?.value === "fn")) return this.parseFunction(line);
    if (line.tokens[0]?.type === TokenType.Identifier && line.tokens[1]?.value === "(" && line.tokens.at(-1)?.value === ":") return this.parseFunction(line);
    if (first === "model") return this.parseModel(line);
    if (first === "if") return this.parseControlBlock(line, 1);
    if (first === "for") return this.parseFor(line);
    if (["class", "else", "while", "try", "catch", "finally"].includes(String(first)) || line.tokens.at(-1)?.value === ":") return this.parseControlBlock(line, 1);
    if (first === "return") return this.parseReturn(line);
    return this.parseSimple(line);
  }

  parseTypeAlias(line: Line): TypeAliasNode {
    this.index++;
    const name = String(line.tokens[1]?.value ?? "");
    const generic = parseTypeParams(line.tokens, 2);
    const eq = findTopLevel(line.tokens, "=", generic.next);
    return { kind: "TypeAlias", name, typeParams: generic.params, type: sliceType(line.tokens.slice(eq + 1)), span: { line: line.line, column: line.indent + 1 } };
  }

  parseInterface(line: Line): InterfaceNode {
    this.index++;
    const name = String(line.tokens[1]?.value ?? "");
    const generic = parseTypeParams(line.tokens, 2);
    const extendsIndex = line.tokens.findIndex((tok) => tok.value === "extends");
    const colon = findTopLevel(line.tokens, ":");
    const parents = extendsIndex >= 0 ? splitTopLevel(sliceType(line.tokens.slice(extendsIndex + 1, colon)), ",").map((part) => cleanType(part)) : [];
    const fields: InterfaceFieldNode[] = [];
    while (this.index < this.lines.length && this.lines[this.index].indent > line.indent) {
      const field = parseInterfaceField(this.lines[this.index]);
      if (field) fields.push(field);
      this.index++;
    }
    return { kind: "Interface", name, typeParams: generic.params, parents, fields, span: { line: line.line, column: line.indent + 1 } };
  }

  parseFunction(line: Line): FunctionNode {
    this.index++;
    const signature = parseSignature(line, 0)!;
    return { kind: "Function", ...signature, body: this.parseBlock(line.indent), span: { line: line.line, column: line.indent + 1 } };
  }

  parseModel(line: Line): ModelNode {
    this.index++;
    const name = String(line.tokens[1]?.value ?? "");
    const open = findTopLevel(line.tokens, "(", 2);
    const close = open >= 0 ? findTopLevel(line.tokens, ")", open) : -1;
    const params = open >= 0 && close >= 0 ? parseParams(line.tokens.slice(open + 1, close)) : [];
    return { kind: "Model", name, params, body: this.parseBlock(line.indent), span: { line: line.line, column: line.indent + 1 } };
  }

  parseControlBlock(line: Line, exprStart: number): BlockNode {
    this.index++;
    const colon = findTopLevel(line.tokens, ":");
    const start = line.tokens[0]?.value === "else" && line.tokens[exprStart]?.value === "if"
      ? exprStart + 1
      : exprStart;
    const exprTokens = colon >= 0 ? line.tokens.slice(start, colon) : [];
    const test = exprTokens.length ? parseExpr(exprTokens) : undefined;
    return { kind: "Block", test, body: this.parseBlock(line.indent), span: { line: line.line, column: line.indent + 1 } };
  }

  parseReturn(line: Line): SemanticNode {
    this.index++;
    const tokens = line.tokens.slice(1);
    return { kind: "Return", value: tokens.length ? parseExpr(tokens) : undefined, span: { line: line.line, column: line.indent + 1 } };
  }

  parseSimple(line: Line): SemanticNode {
    this.index++;
    const declKeyword = ["let", "const", "var"].includes(String(line.tokens[0]?.value));
    if (declKeyword) {
      const eq = findTopLevel(line.tokens, "=");
      const nameToken = line.tokens[1];
      const value = eq > 0 ? parseExprOrNull(line.tokens.slice(eq + 1)) : null;
      if (nameToken?.type === TokenType.Identifier && value) {
        return { kind: "Var", name: String(nameToken.value), value, span: { line: line.line, column: line.indent + 1 } };
      }
      return { kind: "Block", body: [], span: { line: line.line, column: line.indent + 1 } };
    }
    const colon = findTopLevel(line.tokens, ":");
    const eq = findTopLevel(line.tokens, "=");
    if (eq > 0 && line.tokens[0]?.type === TokenType.Identifier) {
      const declaredType = colon > 0 && colon < eq ? sliceType(line.tokens.slice(colon + 1, eq)) : undefined;
      const value = parseExprOrNull(line.tokens.slice(eq + 1));
      if (value) return { kind: "Var", name: String(line.tokens[0].value), declaredType, value, span: { line: line.line, column: line.indent + 1 } };
    }
    const value = parseExprOrNull(line.tokens);
    return value
      ? { kind: "Expr", value, span: { line: line.line, column: line.indent + 1 } }
      : { kind: "Block", body: [], span: { line: line.line, column: line.indent + 1 } };
  }

  parseFor(line: Line): ForNode | BlockNode {
    const variable = line.tokens[1];
    const mode = line.tokens[2];
    const colon = findTopLevel(line.tokens, ":");
    if (variable?.type !== TokenType.Identifier || (mode?.value !== "of" && mode?.value !== "in") || colon < 0) {
      return this.parseControlBlock(line, 1);
    }
    this.index++;
    const iterable = parseExpr(line.tokens.slice(3, colon));
    return {
      kind: "For",
      variable: String(variable.value),
      mode: mode.value,
      iterable,
      body: this.parseBlock(line.indent),
      span: { line: line.line, column: line.indent + 1 },
      variableSpan: { line: variable.line, column: variable.column },
    };
  }
}

function annotateExpression(node: ASTNode, tokens: Token[]): ASTNode {
  annotateNode(node, tokens, { index: 0 });
  return node;
}

function annotateNode(node: ASTNode | null | undefined, tokens: Token[], cursor: { index: number }): void {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      markNode(node, findNext(tokens, cursor, (tok) => tok.value === node.name));
      break;
    case "Literal":
      markNode(node, findNext(tokens, cursor, (tok) => literalMatches(tok, node)));
      break;
    case "MemberExpression":
    case "OptionalMemberExpression": {
      annotateNode(node.object as ASTNode, tokens, cursor);
      copySpan(node, node.object as ASTNode);
      const dot = findNext(tokens, cursor, (tok) => tok.value === "." || tok.value === "?.");
      if (dot) {
        cursor.index = tokens.indexOf(dot) + 1;
        if (typeof node.property === "string") findNext(tokens, cursor, (tok) => tok.value === node.property);
        else annotateNode(node.property as ASTNode, tokens, cursor);
      }
      break;
    }
    case "CallExpression":
    case "OptionalCallExpression":
      annotateNode(node.callee as ASTNode, tokens, cursor);
      copySpan(node, node.callee as ASTNode);
      findNext(tokens, cursor, (tok) => tok.value === "(");
      for (const arg of node.args as ASTNode[]) annotateNode(arg, tokens, cursor);
      break;
    case "NamedArgument": {
      const name = findNext(tokens, cursor, (tok) => tok.value === node.name);
      markNode(node, name);
      findNext(tokens, cursor, (tok) => tok.value === "=");
      annotateNode(node.value as ASTNode, tokens, cursor);
      break;
    }
    case "BinaryExpression":
    case "LogicalExpression":
    case "NullishCoalescingExpression":
      annotateNode(node.left as ASTNode, tokens, cursor);
      copySpan(node, node.left as ASTNode);
      if ("op" in node) findNext(tokens, cursor, (tok) => tok.value === node.op);
      annotateNode(node.right as ASTNode, tokens, cursor);
      break;
    case "ArrayExpression":
      markNode(node, findNext(tokens, cursor, (tok) => tok.value === "["));
      for (const item of node.elements as Array<ASTNode | null>) annotateNode(item, tokens, cursor);
      break;
    case "ObjectExpression":
      markNode(node, findNext(tokens, cursor, (tok) => tok.value === "{"));
      for (const prop of node.properties as Array<{ value?: ASTNode; argument?: ASTNode }>) {
        annotateNode(prop.value ?? prop.argument, tokens, cursor);
      }
      break;
    case "ConditionalExpression":
      annotateNode(node.test as ASTNode, tokens, cursor);
      copySpan(node, node.test as ASTNode);
      annotateNode(node.consequent as ASTNode, tokens, cursor);
      annotateNode(node.alternate as ASTNode, tokens, cursor);
      break;
    case "ArrowFunctionExpression":
      markNode(node, tokens[cursor.index]);
      break;
    default:
      markNode(node, tokens[cursor.index]);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) if (item && typeof item === "object" && "type" in item) annotateNode(item as ASTNode, tokens, cursor);
        } else if (value && typeof value === "object" && "type" in value) {
          annotateNode(value as ASTNode, tokens, cursor);
        }
      }
      break;
  }
}

function findNext(tokens: Token[], cursor: { index: number }, matches: (tok: Token) => boolean): Token | undefined {
  for (let i = cursor.index; i < tokens.length; i++) {
    if (matches(tokens[i])) {
      cursor.index = i + 1;
      return tokens[i];
    }
  }
  return undefined;
}

function markNode(node: ASTNode, token: Token | undefined): void {
  if (!token) return;
  const target = node as PositionedNode;
  target.__line = token.line;
  target.__column = token.column;
}

function copySpan(target: ASTNode, source: ASTNode): void {
  const from = source as PositionedNode;
  if (!from.__line || !from.__column) return;
  const to = target as PositionedNode;
  to.__line = from.__line;
  to.__column = from.__column;
}

function literalMatches(tok: Token, node: ASTNode): boolean {
  if (node.kind === "number") return tok.type === TokenType.Number && Number(tok.value) === node.value;
  if (node.kind === "string") return tok.type === TokenType.String && tok.value === node.value;
  if (node.kind === "boolean") return tok.value === (node.value ? "true" : "false");
  if (node.kind === "null") return tok.value === "null";
  return tok.value === "undefined";
}

export function parseSemanticProgram(source: string): SemanticProgram {
  return new SemanticParser(source).parse();
}

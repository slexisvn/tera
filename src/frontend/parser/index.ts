import {
  NodeType,
  Program,
  FunctionDeclaration,
  AsyncFunctionDeclaration,
  LazyFunctionDeclaration,
  LetDeclaration,
  ConstDeclaration,
  VarDeclaration,
  IfStatement,
  WhileStatement,
  ForStatement,
  ReturnStatement,
  EmptyStatement,
  BlockStatement,
  ExpressionStatement,
  AssignmentExpression,
  BinaryExpression,
  UnaryExpression,
  LogicalExpression,
  CallExpression,
  NamedArgument,
  NewExpression,
  MemberExpression,
  IndexExpression,
  IndexElementNode,
  ObjectExpression,
  ArrayExpression,
  ConditionalExpression,
  AwaitExpression,
  SwitchStatement,
  SwitchCase,
  BreakStatement,
  TryStatement,
  ThrowStatement,
  ClassDeclaration,
  ModelDeclaration,
  TypeAliasDeclaration,
  InterfaceDeclaration,
  ForInStatement,
  ForOfStatement,
  Identifier,
  Literal,
  ThisExpression,
  ObjectDestructuring,
  ArrayDestructuring,
  GeneratorFunctionDeclaration,
  YieldExpression,
  UpdateExpression,
  DoWhileStatement,
  ContinueStatement,
  CompoundAssignmentExpression,
  ArrowFunctionExpression,
  FunctionExpression,
  TemplateLiteral,
  OptionalMemberExpression,
  OptionalCallExpression,
  NullishCoalescingExpression,
  SpreadElement,
  LabeledStatement,
  SuperExpression,
  SuperCallExpression,
  SequenceExpression,
  type ASTNode,
  type BindingTarget,
  type BindingIdentifier,
  type BindingPattern,
  type ObjectBindingPattern,
  type ArrayBindingPattern,
  type ParamNode,
  type FunctionParamInfo,
  type InterfaceFieldAstNode,
  type InterfaceIndexAstNode,
  type ModelFieldAstNode,
  type ModelSectionNode,
} from "../ast/index.js";

import { CLASS_ABSTRACT_MODIFIER, CLASS_MEMBER_MODIFIER_KEYWORDS, CLASS_STATIC_MODIFIER, CLASS_VISIBILITY_KEYWORDS, DEFAULT_CLASS_VISIBILITY, classVisibilityOrDefault, isClassVisibility, type ClassVisibility } from "../../core/class-visibility.js";
import { Lexer, TokenType, type Token, type TokenTypeName, type TokenValue } from "../lexer/index.js";
import { typeSourceFromTokens } from "../type-source.js";
import { buildSyntaxPluginIndex, normalizeSyntaxPlugins, syntaxPluginsFor, type ParserCheckpoint, type ParserContext, type ParserSyntaxOptions, type StatementParseResult, type SyntaxPlugin, type SyntaxPluginIndex } from "./extensions.js";
export { MODEL_MARKER } from "../model.js";

export type ParserOptions = ParserSyntaxOptions & {
  lazy?: boolean;
  source?: string | null;
  depth?: number;
};
type ParserToken = Token;
type ParserNode = ASTNode;
type StatementResult = ASTNode | ASTNode[];
type ClassMemberModifiers = {
  isStatic: boolean;
  visibility: ClassVisibility;
  explicitVisibility: boolean;
  isAbstract: boolean;
};
type ParamsParseResult = {
  params: ParamNode[];
  info: FunctionParamInfo[];
};

function bindingIdentifier(token: ParserToken): BindingIdentifier {
  const identifier: BindingIdentifier = { kind: "id", name: String(token.value) };
  Object.defineProperties(identifier, {
    __line: { value: token.line },
    __column: { value: token.column },
  });
  return identifier;
}

function withSpan<T extends ASTNode>(node: T, token: ParserToken | null | undefined): T {
  if (!token) return node;
  const properties: PropertyDescriptorMap = {
    __line: { value: token.line, configurable: true },
    __column: { value: token.column, configurable: true },
  };
  if (typeof token.value === "string") properties.__raw = { value: token.value, configurable: true };
  Object.defineProperties(node, properties);
  return node;
}

function withNameSpan<T extends ASTNode>(node: T, token: ParserToken | null | undefined): T {
  if (!token) return node;
  Object.defineProperties(node, {
    __nameLine: { value: token.line, configurable: true },
    __nameColumn: { value: token.column, configurable: true },
  });
  return node;
}

function copySpan<T extends ASTNode>(node: T, source: ASTNode): T {
  const positioned = source as ASTNode & { __line?: number; __column?: number };
  Object.defineProperties(node, {
    __line: { value: positioned.__line, configurable: true },
    __column: { value: positioned.__column, configurable: true },
  });
  return node;
}

function withPropertySpan<T extends ASTNode>(node: T, token: ParserToken | null | undefined): T {
  if (!token) return node;
  Object.defineProperties(node, {
    __propertyLine: { value: token.line, configurable: true },
    __propertyColumn: { value: token.column, configurable: true },
  });
  return node;
}

const PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 1,
  or: 1,
  "&&": 2,
  and: 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "===": 6,
  "!==": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  instanceof: 7,
  in: 7,
  "<<": 8,
  ">>": 8,
  ">>>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "@": 10,
  "**": 11,
};

const LOGICAL_OPS = new Set(["&&", "||"]);

function canonicalOperator(op: string): string {
  if (op === "and") return "&&";
  if (op === "or") return "||";
  return op;
}

const TYPE_ARGUMENT_PUNCTUATORS = new Set<TokenValue>([
  "<",
  ">",
  ",",
  ".",
  "[",
  "]",
]);

const BINARY_OPS = new Set([
  "==",
  "!=",
  "===",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "@",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "**",
  "instanceof",
  "in",
]);

const COMPOUND_ASSIGN_OPS = new Set([
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
  "**=",
]);

export class Parser {
  tokens: ParserToken[];
  pos: number;
  lazy: boolean;
  source: string | null;
  depth: number;
  syntaxPlugins: readonly SyntaxPlugin[];
  syntaxPluginIndex: SyntaxPluginIndex;
  private readonly parserContext: ParserContext;

  constructor(tokens: Token[], options: ParserOptions = {}) {
    this.tokens = tokens;
    this.pos = 0;
    this.lazy = options.lazy || false;
    this.source = options.source || null;
    this.depth = options.depth || 0;
    this.syntaxPlugins = normalizeSyntaxPlugins(options.syntaxPlugins);
    this.syntaxPluginIndex = buildSyntaxPluginIndex(this.syntaxPlugins);
    this.parserContext = this.createParserContext();
  }

  private createParserContext(): ParserContext {
    return {
      current: () => this.current(),
      peek: (offset?: number) => this.peek(offset),
      advance: () => this.advance(),
      check: (type, value) => this.check(type, value),
      match: (type, value) => this.match(type, value),
      expect: (type, value) => this.expect(type, value),
      tokenString: (token, context) => this.tokenString(token, context),
      parseExpression: (minPrecedence?: number) => this.parseExpression(minPrecedence),
      parseBlock: () => this.parseBlock(),
      parseStatement: () => this.parseStatement(),
      parseStatementBody: () => this.parseStatementBody(),
      withSpan: (node, token) => this.withSpan(node, token),
      copySpan: (node, source) => this.copySpan(node, source),
      checkpoint: () => this.checkpoint(),
      restore: (checkpoint) => this.restore(checkpoint),
      error: (message, token) => this.error(message, token),
    };
  }

  current(): ParserToken {
    return this.tokens[this.pos];
  }

  peek(offset = 1): ParserToken {
    return (
      this.tokens[this.pos + offset] ?? {
        type: TokenType.EOF,
        value: "",
        line: 0,
        column: 0,
      }
    );
  }

  advance(): ParserToken {
    const tok = this.tokens[this.pos];
    this.pos++;
    return tok;
  }

  check(type: TokenTypeName, value?: TokenValue): boolean {
    const tok = this.current();
    if (tok.type !== type) return false;
    if (value !== undefined && tok.value !== value) return false;
    return true;
  }

  match(type: TokenTypeName, value?: TokenValue): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  expect(type: TokenTypeName, value?: TokenValue): ParserToken {
    if (this.check(type, value)) {
      return this.advance();
    }
    const tok = this.current();
    const expected = value !== undefined ? `'${String(value)}'` : type;
    this.error(`Expected ${expected}, got '${tok.value}' (${tok.type})`, tok);
  }

  consumeSemicolon(): void {
    if (this.match(TokenType.Punctuator, ";")) return;
    if (this.match(TokenType.Newline)) {
      while (this.match(TokenType.Newline)) {}
      return;
    }
    if (this.check(TokenType.Punctuator, "}") || this.check(TokenType.Dedent) || this.isAtEnd()) return;

    const prev = this.tokens[this.pos - 1];
    const curr = this.current();
    if (prev && curr && curr.line > prev.line) {
      return; 
    }

    this.expect(TokenType.Punctuator, ";");
  }

  error(message: string, tok?: ParserToken): never {
    tok = tok ?? this.current();
    throw new SyntaxError(`[Parser] ${message} at ${tok.line}:${tok.column}`);
  }

  tokenString(tok: ParserToken, context = "token"): string {
    if (typeof tok.value !== "string") {
      this.error(`Expected string ${context}`, tok);
    }
    return tok.value;
  }

  withSpan<T extends ASTNode>(node: T, token: ParserToken | null | undefined): T {
    return withSpan(node, token);
  }

  copySpan<T extends ASTNode>(node: T, source: ASTNode): T {
    return copySpan(node, source);
  }

  checkpoint(): ParserCheckpoint {
    return { position: this.pos };
  }

  restore(checkpoint: ParserCheckpoint): void {
    if (!Number.isInteger(checkpoint.position) || checkpoint.position < 0 || checkpoint.position > this.tokens.length) {
      this.error(`Invalid parser checkpoint '${checkpoint.position}'`);
    }
    this.pos = checkpoint.position;
  }

  expectString(type: TokenTypeName, value?: string): string {
    return this.tokenString(this.expect(type, value), type);
  }

  isStatementSeparator(tok = this.current()): boolean {
    return tok.type === TokenType.Newline || (tok.type === TokenType.Punctuator && tok.value === ";");
  }

  skipStatementSeparators(): void {
    while (this.isStatementSeparator()) this.advance();
  }

  isBodyStart(): boolean {
    return this.check(TokenType.Punctuator, ":");
  }

  isBodyEnd(): boolean {
    return this.check(TokenType.Dedent);
  }

  parseBodyStart(): void {
    this.expect(TokenType.Punctuator, ":");
    while (this.match(TokenType.Newline)) {}
    this.expect(TokenType.Indent);
  }

  parseBodyEnd(): void {
    this.expect(TokenType.Dedent);
  }

  tokenStringValue(value: string | ASTNode): string {
    if (typeof value !== "string") {
      this.error("Expected string property name");
    }
    return value;
  }

  checkValue(value: string): boolean {
    const current = this.current();
    return typeof current?.value === "string" && current.value === value;
  }

  parseClassMemberModifiers(): ClassMemberModifiers {
    let isStatic = false;
    let isAbstract = false;
    let visibility: ClassVisibility | null = null;
    while (true) {
      const value = this.current()?.value;
      if (value === CLASS_STATIC_MODIFIER && this.isStaticModifierAhead()) {
        if (isStatic) this.error("Duplicate class member modifier 'static'");
        isStatic = true;
        this.advance();
        continue;
      }
      if (value === CLASS_ABSTRACT_MODIFIER) {
        if (isAbstract) this.error("Duplicate class member modifier 'abstract'");
        isAbstract = true;
        this.advance();
        continue;
      }
      if (isClassVisibility(value)) {
        if (visibility) this.error(`Conflicting class member visibility '${visibility}' and '${value}'`);
        visibility = value;
        this.advance();
        continue;
      }
      break;
    }
    return { isStatic, isAbstract, visibility: classVisibilityOrDefault(visibility), explicitVisibility: visibility !== null };
  }

  isStaticModifierAhead(): boolean {
    const next = this.peek();
    if (typeof next.value !== "string") return false;
    if (CLASS_MEMBER_MODIFIER_KEYWORDS.has(next.value)) return true;
    if (CLASS_VISIBILITY_KEYWORDS.has(next.value)) return true;
    return next.type === TokenType.Identifier || next.type === TokenType.Keyword;
  }

  isBindingIdentifier(target: BindingPattern): target is BindingIdentifier {
    return typeof target === "object" && !Array.isArray(target) && target.kind === "id";
  }

  isIdentifierToken(tok = this.current()): boolean {
    return tok.type === TokenType.Identifier || tok.type === TokenType.Keyword;
  }

  isAtEnd(): boolean {
    return this.current().type === TokenType.EOF;
  }

  parse(): ASTNode {
    return this.parseProgram();
  }

  parseProgram(): ASTNode {
    const body: ASTNode[] = [];
    this.skipStatementSeparators();
    while (!this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) body.push(...stmt);
      else body.push(stmt);
      this.skipStatementSeparators();
    }
    return Program(body);
  }

  parseStatement(): StatementResult {
    const tok = this.current();

    if (this.isStatementSeparator()) {
      this.advance();
      return EmptyStatement();
    }

    const extension = this.parseExtensionStatement();
    if (extension) return extension;

    if (tok.type === TokenType.Keyword) {
      switch (tok.value) {
        case "function":
          return this.parseFunctionDeclaration();
        case "fn":
          return this.parseFunctionDeclaration(false, "fn");
        case "model":
          return this.parseModelDeclaration();
        case "async":
          if (
            this.peek().type === TokenType.Keyword &&
            (this.peek().value === "fn" || this.peek().value === "function")
          ) {
            return this.parseFunctionDeclaration(true, String(this.peek().value));
          }
          break;
        case "let":
          return this.parseLetDeclaration();
        case "const":
          return this.parseConstDeclaration();
        case "var":
          return this.parseVarDeclaration();
        case "if":
          return this.parseIfStatement();
        case "while":
          return this.parseWhileStatement();
        case "for":
          return this.parseForStatement();
        case "return":
          return this.parseReturnStatement();
        case "switch":
          return this.parseSwitchStatement();
        case "break":
          return this.parseBreakStatement();
        case "try":
          return this.parseTryStatement();
        case "throw":
          return this.parseThrowStatement();
        case "class":
          return this.parseClassDeclaration();
        case CLASS_ABSTRACT_MODIFIER:
          if (this.peek().type === TokenType.Keyword && this.peek().value === "class") {
            return this.parseClassDeclaration();
          }
          break;
        case "do":
          return this.parseDoWhileStatement();
        case "continue":
          return this.parseContinueStatement();
      }
    }

    if (this.isTypeDeclarationStart()) {
      return this.parseTypeOnlyDeclaration();
    }

    if (this.isTypedAssignmentStart()) {
      return this.parseTypedAssignment();
    }

    if (this.isDestructuringAssignmentStart()) {
      return this.parseDestructuringAssignment();
    }

    if (this.isBareTupleDestructuringStart()) {
      return this.parseBareTupleDestructuring();
    }

    if (
      tok.type === TokenType.Identifier &&
      this.peek().type === TokenType.Punctuator &&
      this.peek().value === ":"
    ) {
      const label = this.tokenString(this.advance(), "label");
      const colon = this.advance();
      let body = this.parseLabelBody(colon);
      if (Array.isArray(body)) body = BlockStatement(body);
      return LabeledStatement(label, body);
    }

    if (this.isBodyStart()) {
      return this.parseBlock();
    }

    return this.parseExpressionStatement();
  }

  isTypeDeclarationStart(): boolean {
    const tok = this.current();
    return tok.type === TokenType.Identifier && (tok.value === "type" || tok.value === "interface");
  }

  parseTypeOnlyDeclaration(): ASTNode {
    const start = this.advance();
    const kind = this.tokenString(start, "type declaration");
    if (kind === "interface") return this.parseInterfaceDeclaration(start);

    const nameToken = this.expect(TokenType.Identifier);
    const name = this.tokenString(nameToken, "type alias name");
    const typeParams = this.parseGenericArguments();
    this.expect(TokenType.Punctuator, "=");
    const declaredType = this.parseTypeSource(new Set([";"]));
    this.consumeSemicolon();
    return withNameSpan(withSpan(TypeAliasDeclaration(name, typeParams, declaredType), start), nameToken);
  }

  parseInterfaceDeclaration(start: ParserToken): ASTNode {
    const nameToken = this.expect(TokenType.Identifier);
    const name = this.tokenString(nameToken, "interface name");
    const typeParams = this.parseGenericArguments();
    const parents: string[] = [];
    if (this.match(TokenType.Keyword, "extends") || this.match(TokenType.Identifier, "extends")) {
      while (!this.isAtEnd() && !this.isBodyStart() && !this.isStatementSeparator()) {
        parents.push(this.parseTypeSource(new Set([",", ":", "{", ";"])));
        if (!this.match(TokenType.Punctuator, ",")) break;
      }
    }
    this.parseBodyStart();
    const fields: InterfaceFieldAstNode[] = [];
    const indexers: InterfaceIndexAstNode[] = [];
    this.skipStatementSeparators();
    while (!this.isBodyEnd() && !this.isAtEnd()) {
      const entry = this.parseInterfaceEntry();
      if ("valueType" in entry) indexers.push(entry);
      else fields.push(entry);
      this.consumeSemicolon();
      this.skipStatementSeparators();
    }
    this.parseBodyEnd();
    return withNameSpan(withSpan(InterfaceDeclaration(name, typeParams, parents.filter(Boolean), fields, indexers), start), nameToken);
  }

  parseInterfaceEntry(): InterfaceFieldAstNode | InterfaceIndexAstNode {
    if (this.match(TokenType.Punctuator, "[")) {
      const keyName = this.check(TokenType.Identifier) ? this.advance() : null;
      this.expect(TokenType.Punctuator, ":");
      const keyType = this.parseTypeSource(new Set(["]"]));
      this.expect(TokenType.Punctuator, "]");
      this.expect(TokenType.Punctuator, ":");
      const valueType = this.parseTypeSource(new Set([";", "}"]));
      void keyName;
      return { keyType, valueType };
    }

    this.match(TokenType.Identifier, "readonly");
    const nameToken = this.expect(TokenType.Identifier);
    const name = this.tokenString(nameToken, "interface member name");
    const optional = this.match(TokenType.Punctuator, "?");
    if (!optional && (this.check(TokenType.Punctuator, "(") || this.check(TokenType.Punctuator, "<"))) {
      const typeParams = this.parseGenericArguments();
      const parsedParams = this._parseParamsWithInfo();
      const returns = this.skipReturnType() ?? "any";
      const type = `(${parsedParams.info.map((param) => param.type ?? "any").join(", ")}) -> ${returns}`;
      void typeParams;
      return { name, type, optional: false, kind: "method", __line: nameToken.line, __column: nameToken.column };
    }
    this.expect(TokenType.Punctuator, ":");
    const type = this.parseTypeSource(new Set([";", "}"]));
    return { name, type, optional, kind: "field", __line: nameToken.line, __column: nameToken.column };
  }

  skipBalancedBlock(): void {
    this.expect(TokenType.Punctuator, "{");
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      const tok = this.advance();
      if (tok.type !== TokenType.Punctuator) continue;
      if (tok.value === "{") depth++;
      else if (tok.value === "}") depth--;
    }
  }

  isTypedAssignmentStart(): boolean {
    if (!this.check(TokenType.Identifier) || this.peek().value !== ":") return false;
    const saved = this.pos;
    this.advance();
    this.advance();
    this.skipType();
    const isAssignment = this.check(TokenType.Punctuator, "=");
    this.pos = saved;
    return isAssignment;
  }

  parseTypedAssignment(): ASTNode {
    const start = this.current();
    const nameToken = this.expect(TokenType.Identifier);
    const name = this.tokenString(nameToken, "identifier");
    const declaredType = this.skipTypeAnnotation(new Set(["="]));
    let init = null;
    if (this.match(TokenType.Punctuator, "=")) {
      init = this.parseExpression();
    }
    this.consumeSemicolon();
    const node = LetDeclaration(name, init);
    node.declaredType = declaredType;
    return withNameSpan(withSpan(node, start), nameToken);
  }

  isDestructuringAssignmentStart(): boolean {
    if (!this.check(TokenType.Punctuator, "[") && !this.check(TokenType.Punctuator, "{")) return false;
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (depth === 0 && (tok.type === TokenType.Newline || tok.type === TokenType.Dedent)) return false;
      if (tok.type !== TokenType.Punctuator) continue;
      if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
      else if (tok.value === ")" || tok.value === "]" || tok.value === "}") depth--;
      else if (depth === 0 && tok.value === ";") return false;
      if (depth === 0 && tok.value === "=") return true;
    }
    return false;
  }

  isBareTupleDestructuringStart(): boolean {
    if (!this.check(TokenType.Identifier)) return false;
    if (!(this.peek().type === TokenType.Punctuator && this.peek().value === ",")) return false;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.type === TokenType.Newline || tok.type === TokenType.Dedent) return false;
      if (tok.type === TokenType.Identifier) continue;
      if (tok.type !== TokenType.Punctuator) return false;
      if (tok.value === ",") continue;
      if (tok.value === "=") return true;
      return false;
    }
    return false;
  }

  parseBareTupleDestructuring(): ASTNode {
    const elements: Array<BindingPattern | null> = [];
    do {
      if (this.check(TokenType.Punctuator, "{")) elements.push(this._parseObjectPattern());
      else if (this.check(TokenType.Punctuator, "[")) elements.push(this._parseArrayPattern());
      else elements.push(bindingIdentifier(this.expect(TokenType.Identifier)));
    } while (this.match(TokenType.Punctuator, ","));
    this.expect(TokenType.Punctuator, "=");
    const init = this.parseExpression();
    this.consumeSemicolon();
    return ArrayDestructuring({ kind: "array", elements, rest: null }, init, "let");
  }

  parseDestructuringAssignment(): ASTNode {
    if (this.check(TokenType.Punctuator, "[")) {
      const pattern = this._parseArrayPattern();
      this.expect(TokenType.Punctuator, "=");
      const init = this.parseExpression();
      this.consumeSemicolon();
      return ArrayDestructuring(pattern, init, "let");
    }
    const pattern = this._parseObjectPattern();
    this.expect(TokenType.Punctuator, "=");
    const init = this.parseExpression();
    this.consumeSemicolon();
    return ObjectDestructuring(pattern, init, "let");
  }

  skipTypeAnnotation(stops = new Set<string>([",", "=", ")", ";", "{", "}"])): string | undefined {
    if (!this.match(TokenType.Punctuator, ":")) return undefined;
    return this.parseTypeSource(stops);
  }

  skipReturnType(): string | undefined {
    if (!this.match(TokenType.Punctuator, "->")) return undefined;
    return this.parseTypeSource(new Set([":", "{", ";", "}"]));
  }

  parseTypeSource(stops: Set<string>): string {
    const tokens: ParserToken[] = [];
    let depth = 0;
    while (!this.isAtEnd()) {
      const tok = this.current();
      if (tok.type === TokenType.Newline || tok.type === TokenType.Indent || tok.type === TokenType.Dedent) break;
      if (depth === 0 && tokens.length > 0 && tok.line > tokens[tokens.length - 1].line) break;
      if (tok.type === TokenType.Punctuator) {
        const startsDelimitedType = tok.value === "{" && tokens.length === 0;
        if (depth === 0 && typeof tok.value === "string" && stops.has(tok.value) && !startsDelimitedType) break;
        if (tok.value === "(" || tok.value === "[" || tok.value === "{" || tok.value === "<") depth++;
        else if (tok.value === ">>") {
          depth = Math.max(0, depth - 2);
        } else if (tok.value === ">>>") {
          depth = Math.max(0, depth - 3);
        } else if (tok.value === ")" || tok.value === "]" || tok.value === "}" || tok.value === ">") {
          if (depth === 0) break;
          depth--;
        }
      }
      tokens.push(this.advance());
    }
    return typeSourceFromTokens(tokens);
  }

  skipType(): void {
    this.skipTypePrimary();
    while (
      this.check(TokenType.Punctuator, "|") ||
      this.check(TokenType.Punctuator, "&") ||
      this.check(TokenType.Punctuator, "->")
    ) {
      this.advance();
      this.skipTypePrimary();
    }
  }

  skipTypePrimary(): void {
    const tok = this.current();
    if (tok.type === TokenType.Keyword && tok.value === "fn") {
      this.advance();
      if (this.check(TokenType.Punctuator, "(")) this.skipBracketed();
      if (this.check(TokenType.Punctuator, "->")) {
        this.advance();
        this.skipTypePrimary();
      }
      return;
    }
    if (tok.type === TokenType.Punctuator) {
      if (tok.value === "{" || tok.value === "(" || tok.value === "[") this.skipBracketed();
      else return;
    } else {
      this.advance();
      while (this.check(TokenType.Punctuator, ".") && this.peek().type === TokenType.Identifier) {
        this.advance();
        this.advance();
      }
      if (this.check(TokenType.Punctuator, "<")) this.skipTypeArguments();
    }
    while (this.check(TokenType.Punctuator, "[")) this.skipBracketed();
  }

  skipTypeArguments(): void {
    this.advance();
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      const tok = this.current();
      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") {
          this.skipBracketed();
          continue;
        }
        if (tok.value === "<") depth++;
        else if (tok.value === ">") depth--;
        else if (tok.value === ">>") depth -= 2;
        else if (tok.value === ">>>") depth -= 3;
      }
      this.advance();
    }
  }

  skipBracketed(): void {
    let depth = 0;
    do {
      const tok = this.advance();
      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
        else if (tok.value === ")" || tok.value === "]" || tok.value === "}") depth--;
      }
    } while (depth > 0 && !this.isAtEnd());
  }

  parseGenericArguments(): string[] {
    if (!this.match(TokenType.Punctuator, "<")) return [];
    let depth = 1;
    const args: Token[][] = [[]];
    while (depth > 0 && !this.isAtEnd()) {
      const tok = this.advance();
      if (tok.type !== TokenType.Punctuator) {
        args[args.length - 1].push(tok);
      } else if (tok.value === "<") {
        depth++;
        args[args.length - 1].push(tok);
      } else if (tok.value === ">") {
        depth--;
        if (depth > 0) args[args.length - 1].push(tok);
      } else if (tok.value === "," && depth === 1) {
        args.push([]);
      } else {
        args[args.length - 1].push(tok);
      }
    }
    return args.map((arg) => arg.map((tok) => String(tok.value)).join(" ").trim()).filter(Boolean);
  }

  skipGenericParameters(): void {
    this.parseGenericArguments();
  }

  _parseParams(): ParamNode[] {
    return this._parseParamsWithInfo().params;
  }

  _parseParamsWithInfo(): ParamsParseResult {
    this.expect(TokenType.Punctuator, "(");
    const params: ParamNode[] = [];
    const info: FunctionParamInfo[] = [];
    if (!this.check(TokenType.Punctuator, ")")) {
      do {
        if (this.match(TokenType.Punctuator, "...")) {
          const nameToken = this.expect(TokenType.Identifier);
          const name = this.tokenString(nameToken, "parameter");
          const type = this.skipTypeAnnotation(new Set([",", ")"])) ?? "any";
          params.push({ name, rest: true as const });
          info.push({ name, type, optional: true, line: nameToken.line, column: nameToken.column });
          break;
        }
        if (
          this.check(TokenType.Punctuator, "{") ||
          this.check(TokenType.Punctuator, "[")
        ) {
          const pattern = this._parseBindingTarget();
          if (this.match(TokenType.Punctuator, "=")) {
            params.push({ pattern, default: this.parseExpression() });
          } else {
            params.push({ pattern });
          }
        } else {
          const nameToken = this.expect(TokenType.Identifier);
          const name = this.tokenString(nameToken, "parameter");
          const optionalMark = this.match(TokenType.Punctuator, "?");
          const type = this.skipTypeAnnotation(new Set([",", "=", ")"])) ?? "any";
          if (this.match(TokenType.Punctuator, "=")) {
            const defaultValue = this.parseExpression();
            params.push({ name, default: defaultValue });
            info.push({ name, type, optional: true, line: nameToken.line, column: nameToken.column });
          } else {
            params.push(name);
            info.push({ name, type, optional: optionalMark, line: nameToken.line, column: nameToken.column });
          }
        }
      } while (this.match(TokenType.Punctuator, ","));
    }
    this.expect(TokenType.Punctuator, ")");
    return { params, info };
  }

  parseFunctionDeclaration(isAsync = false, keyword = "function"): ASTNode {
    const start = this.current();
    if (isAsync) this.expect(TokenType.Keyword, "async");
    this.expect(TokenType.Keyword, keyword);
    const isGenerator = this.match(TokenType.Punctuator, "*");
    const nameToken = this.expect(TokenType.Identifier);
    const name = this.tokenString(nameToken, "function name");
    const typeParams = this.parseGenericArguments();

    const parsedParams = this._parseParamsWithInfo();
    const params = parsedParams.params;
    const returnType = this.skipReturnType() ?? "any";

    if (this.lazy && this.depth > 0 && this.check(TokenType.Punctuator, "{")) {
      const bodyStartIdx = this.pos;
      this.expect(TokenType.Punctuator, "{");
      let braceCount = 1;
      while (braceCount > 0 && !this.isAtEnd()) {
        const tok = this.advance();
        if (tok.type === TokenType.Punctuator && tok.value === "{")
          braceCount++;
        else if (tok.type === TokenType.Punctuator && tok.value === "}")
          braceCount--;
      }
      const bodyEndIdx = this.pos;
      const lazyNode = LazyFunctionDeclaration(
        name,
        params,
        this.source ?? "",
        bodyStartIdx,
        bodyEndIdx,
      );
      lazyNode._paramInfo = parsedParams.info;
      lazyNode._returnType = returnType;
      lazyNode._typeParams = typeParams;
      return withNameSpan(withSpan(lazyNode, start), nameToken);
    }

    this.depth++;
    const body = this.parseBlock();
    this.depth--;
    const node = isGenerator
      ? GeneratorFunctionDeclaration(name, params, body)
      : isAsync
        ? AsyncFunctionDeclaration(name, params, body)
        : FunctionDeclaration(name, params, body);
    node._paramInfo = parsedParams.info;
    node._returnType = returnType;
    node._typeParams = typeParams;
    return withNameSpan(withSpan(node, start), nameToken);
  }

  parseLetDeclaration(): ASTNode | ASTNode[] {
    this.expect(TokenType.Keyword, "let");
    return this._parseDeclarationBody("let");
  }

  parseConstDeclaration(): ASTNode | ASTNode[] {
    this.expect(TokenType.Keyword, "const");
    return this._parseDeclarationBody("const");
  }

  parseVarDeclaration(): ASTNode | ASTNode[] {
    this.expect(TokenType.Keyword, "var");
    return this._parseDeclarationBody("var");
  }

  _parseDeclarationBody(kind: "let" | "const" | "var"): ASTNode | ASTNode[] {
    const declarations = [];
    do {
      if (this.check(TokenType.Punctuator, "{")) {
        const pattern = this._parseObjectPattern();
        this.expect(TokenType.Punctuator, "=");
        const init = this.parseExpression();
        declarations.push(ObjectDestructuring(pattern, init, kind));
      } else if (this.check(TokenType.Punctuator, "[")) {
        const pattern = this._parseArrayPattern();
        this.expect(TokenType.Punctuator, "=");
        const init = this.parseExpression();
        declarations.push(ArrayDestructuring(pattern, init, kind));
      } else {
        const start = this.current();
        const nameToken = this.expect(TokenType.Identifier);
        const name = this.tokenString(nameToken, "identifier");
        const declaredType = this.skipTypeAnnotation(new Set([",", "="]));

        let init = null;
        if (this.match(TokenType.Punctuator, "=")) {
          init = this.parseExpression();
        } else if (kind === "const") {
          throw new Error(
            `SyntaxError: Missing initializer in const declaration for '${name}'`,
          );
        }

        const node = kind === "const"
            ? ConstDeclaration(name, init)
            : kind === "var"
              ? VarDeclaration(name, init)
              : LetDeclaration(name, init);
        node.declaredType = declaredType;
        declarations.push(withNameSpan(withSpan(node, start), nameToken));
      }
    } while (this.match(TokenType.Punctuator, ","));

    this.consumeSemicolon();
    return declarations.length === 1 ? declarations[0] : declarations;
  }

  _parseBindingTarget(): BindingPattern {
    let target: BindingPattern;
    if (this.check(TokenType.Punctuator, "{")) {
      target = this._parseObjectPattern();
    } else if (this.check(TokenType.Punctuator, "[")) {
      target = this._parseArrayPattern();
    } else {
      const token = this.expect(TokenType.Identifier);
      target = bindingIdentifier(token);
    }
    if (this.isBindingIdentifier(target) && this.match(TokenType.Punctuator, "=")) {
      target.default = this.parseExpression();
    }
    return target;
  }

  _parseObjectPattern(): ObjectBindingPattern {
    this.expect(TokenType.Punctuator, "{");
    const props = [];
    let rest = null;
    while (!this.check(TokenType.Punctuator, "}")) {
      if (this.match(TokenType.Punctuator, "...")) {
        rest = this.expectString(TokenType.Identifier);
        break;
      }
      const keyToken = this.expect(TokenType.Identifier);
      const key = this.tokenString(keyToken, "binding key");
      let value: BindingPattern;
      if (this.match(TokenType.Punctuator, ":")) {
        value = this._parseBindingTarget();
      } else {
        const identifier: BindingIdentifier = bindingIdentifier(keyToken);
        if (this.match(TokenType.Punctuator, "=")) {
          identifier.default = this.parseExpression();
        }
        value = identifier;
      }
      props.push({ key, value });
      if (!this.check(TokenType.Punctuator, "}")) {
        this.expect(TokenType.Punctuator, ",");
      }
    }
    this.expect(TokenType.Punctuator, "}");
    return { kind: "object", props, rest };
  }

  _parseArrayPattern(): ArrayBindingPattern {
    this.expect(TokenType.Punctuator, "[");
    const elements = [];
    let rest = null;
    while (!this.check(TokenType.Punctuator, "]")) {
      if (this.check(TokenType.Punctuator, ",")) {
        elements.push(null);
      } else if (this.match(TokenType.Punctuator, "...")) {
        rest = this._parseBindingTarget();
        break;
      } else {
        elements.push(this._parseBindingTarget());
      }
      if (!this.check(TokenType.Punctuator, "]")) {
        this.expect(TokenType.Punctuator, ",");
      }
    }
    this.expect(TokenType.Punctuator, "]");
    return { kind: "array", elements, rest };
  }

  parseIfStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "if");
    const test = this.parseControlCondition();

    let consequent = this.parseStatementBody();
    if (Array.isArray(consequent)) consequent = BlockStatement(consequent);

    let alternate = null;

    if (this.match(TokenType.Keyword, "else")) {
      if (this.check(TokenType.Keyword, "if")) {
        alternate = this.parseIfStatement();
      } else if (this.isBodyStart()) {
        alternate = this.parseBlock();
      } else {
        alternate = this.parseStatement();
        if (Array.isArray(alternate)) alternate = BlockStatement(alternate);
      }
    }

    return withSpan(IfStatement(test, consequent, alternate), start);
  }

  parseWhileStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "while");
    const test = this.parseControlCondition();

    let body = this.parseStatementBody();
    if (Array.isArray(body)) body = BlockStatement(body);
    return withSpan(WhileStatement(test, body), start);
  }

  parseForStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "for");
    if (!this.check(TokenType.Punctuator, "(")) {
      const target = this._parseBindingTarget();
      if (
        !this.check(TokenType.Keyword) ||
        (this.current().value !== "in" && this.current().value !== "of")
      ) {
        this.error("Expected 'in' or 'of' in for statement");
      }
      const kind = this.tokenString(this.advance(), "for-kind");
      const binding = target;
      const expr = this.parseExpression();
      let body = this.parseStatementBody();
      if (Array.isArray(body)) body = BlockStatement(body);
      return withSpan(kind === "in"
        ? ForInStatement(binding, expr, body, "let")
        : ForOfStatement(binding, expr, body, "let"), start);
    }
    this.expect(TokenType.Punctuator, "(");

    const declKeyword = this.current();
    if (
      declKeyword.type === TokenType.Keyword &&
      (declKeyword.value === "let" ||
        declKeyword.value === "const" ||
        declKeyword.value === "var")
    ) {
      const savedPos = this.pos;
      const declKind = declKeyword.value;
      this.advance();
      const isPatternStart =
        this.check(TokenType.Identifier) ||
        this.check(TokenType.Punctuator, "[") ||
        this.check(TokenType.Punctuator, "{");
      if (isPatternStart) {
        let target = null;
        try {
          target = this._parseBindingTarget();
        } catch (e) {
          target = null;
        }
        if (
          target &&
          this.check(TokenType.Keyword) &&
          (this.current().value === "in" || this.current().value === "of")
        ) {
          const kind = this.tokenString(this.advance(), "for-kind");
          const binding = target;
          const expr = this.parseExpression();
          this.expect(TokenType.Punctuator, ")");
          let body = this.parseStatementBody();
          if (Array.isArray(body)) body = BlockStatement(body);
          if (kind === "in") {
            return withSpan(ForInStatement(binding, expr, body, declKind), start);
          } else {
            return withSpan(ForOfStatement(binding, expr, body, declKind), start);
          }
        }
      }

      this.pos = savedPos;
    }

    let init = null;
    if (this.check(TokenType.Keyword, "let")) {
      init = this.parseLetDeclaration();
    } else if (this.check(TokenType.Keyword, "const")) {
      init = this.parseConstDeclaration();
    } else if (this.check(TokenType.Keyword, "var")) {
      init = this.parseVarDeclaration();
    } else if (!this.check(TokenType.Punctuator, ";")) {
      init = ExpressionStatement(this.parseExpression());
      this.consumeSemicolon();
    } else {
      this.consumeSemicolon();
    }

    let test = null;
    if (!this.check(TokenType.Punctuator, ";")) {
      test = this.parseExpression();
    }
    this.consumeSemicolon();

    let update = null;
    if (!this.check(TokenType.Punctuator, ")")) {
      update = this.parseExpression();
    }
    this.expect(TokenType.Punctuator, ")");

    let body = this.parseStatementBody();
    if (Array.isArray(body)) body = BlockStatement(body);
    return withSpan(ForStatement(init, test, update, body), start);
  }

  parseControlCondition(): ASTNode {
    if (this.match(TokenType.Punctuator, "(")) {
      const test = this.parseExpression();
      this.expect(TokenType.Punctuator, ")");
      return test;
    }
    return this.parseExpression();
  }

  parseStatementBody(): StatementResult {
    return this.isBodyStart()
      ? this.parseBlock()
      : this.parseStatement();
  }

  parseLabelBody(start: ParserToken): StatementResult {
    if (!this.match(TokenType.Newline)) return this.parseStatement();
    while (this.match(TokenType.Newline)) {}
    this.expect(TokenType.Indent);
    const body: ASTNode[] = [];
    this.skipStatementSeparators();
    while (!this.check(TokenType.Dedent) && !this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) body.push(...stmt);
      else body.push(stmt);
      this.skipStatementSeparators();
    }
    this.expect(TokenType.Dedent);
    return withSpan(BlockStatement(body), start);
  }

  parseReturnStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "return");

    let argument = null;
    if (
      !this.check(TokenType.Punctuator, ";") &&
      !this.check(TokenType.Newline) &&
      !this.check(TokenType.Punctuator, "}") &&
      !this.check(TokenType.Dedent) &&
      !this.isAtEnd()
    ) {
      argument = this.parseExpression();
    }

    this.consumeSemicolon();
    return withSpan(ReturnStatement(argument), start);
  }

  parseBlock(): ASTNode {
    const start = this.current();
    this.parseBodyStart();
    const body = [];
    this.skipStatementSeparators();
    while (!this.isBodyEnd() && !this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) body.push(...stmt);
      else body.push(stmt);
      this.skipStatementSeparators();
    }
    this.parseBodyEnd();
    return withSpan(BlockStatement(body), start);
  }

  parseExpressionStatement(): ASTNode {
    const expression = this.parseExpression();
    this.consumeSemicolon();
    return copySpan(ExpressionStatement(expression), expression);
  }

  parseArguments(end = ")"): ASTNode[] {
    const args: ASTNode[] = [];
    if (!this.check(TokenType.Punctuator, end)) {
      while (true) {
        if (this.check(TokenType.Punctuator, end)) break;
        if (this.match(TokenType.Punctuator, "...")) {
          args.push(SpreadElement(this.parseExpression()));
        } else if (
          this.check(TokenType.Identifier) &&
          this.peek().type === TokenType.Punctuator &&
          this.peek().value === "="
        ) {
          const nameToken = this.expect(TokenType.Identifier);
          const name = this.tokenString(nameToken, "identifier");
          this.expect(TokenType.Punctuator, "=");
          args.push(withSpan(NamedArgument(name, this.parseExpression()), nameToken));
        } else {
          args.push(this.parseExpression());
        }
        if (!this.match(TokenType.Punctuator, ",")) break;
        if (this.check(TokenType.Punctuator, end)) break;
      }
    }
    this.expect(TokenType.Punctuator, end);
    return args;
  }

  isGenericCallAhead(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.type !== TokenType.Punctuator) continue;
      if (tok.value === "<") depth++;
      else if (tok.value === ">") {
        depth--;
        if (depth === 0) {
          return this.tokens[i + 1]?.type === TokenType.Punctuator && this.tokens[i + 1]?.value === "(";
        }
      } else if (depth === 0 || !TYPE_ARGUMENT_PUNCTUATORS.has(tok.value)) {
        return false;
      }
    }
    return false;
  }

  parseExpression(minPrec = 0): ASTNode {
    let left = this.parsePrimary();

    while (true) {
      const extension = this.parseExtensionInfix(left, minPrec);
      if (extension) {
        left = extension;
        continue;
      }

      const tok = this.current();

      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "<" && minPrec <= 12 && this.isGenericCallAhead()) {
          left = copySpan({ ...left, typeArgs: this.parseGenericArguments() } as ASTNode, left);
          continue;
        }

        if (tok.value === "." && minPrec <= 12) {
          this.advance();
          const prop =
            this.check(TokenType.Identifier) || this.check(TokenType.Keyword)
              ? this.advance()
              : this.expect(TokenType.Identifier);
          left = withPropertySpan(copySpan(MemberExpression(left, this.tokenString(prop, "property"), false), left), prop);
          continue;
        }

        if (tok.value === "?." && minPrec <= 12) {
          this.advance();
          if (this.check(TokenType.Punctuator, "(")) {
            this.advance();
            const args = this.parseArguments(")");
            left = copySpan(OptionalCallExpression(left, args), left);
          } else if (this.check(TokenType.Punctuator, "[")) {
            this.advance();
            const index = this.parseExpression();
            this.expect(TokenType.Punctuator, "]");
            left = copySpan(OptionalMemberExpression(left, index, true), left);
          } else {
            const prop =
              this.check(TokenType.Identifier) || this.check(TokenType.Keyword)
                ? this.advance()
                : this.expect(TokenType.Identifier);
            left = withPropertySpan(copySpan(OptionalMemberExpression(left, this.tokenString(prop, "property"), false), left), prop);
          }
          continue;
        }

        if (tok.value === "(" && minPrec <= 12) {
          this.advance();
          const args = this.parseArguments(")");
          left = copySpan(CallExpression(left, args), left);
          continue;
        }

        if (tok.value === "[" && minPrec <= 12) {
          this.advance();
          left = copySpan(this.parseIndexAccess(left), left);
          continue;
        }

        if ((tok.value === "++" || tok.value === "--") && minPrec <= 12) {
          if (
            left.type !== NodeType.Identifier &&
            left.type !== NodeType.MemberExpression
          ) {
            this.error("Invalid update target", tok);
          }

          this.advance();
          left = copySpan(UpdateExpression(this.tokenString(tok, "operator"), left, false), left);
          continue;
        }

        if (typeof tok.value === "string" && COMPOUND_ASSIGN_OPS.has(tok.value) && minPrec <= 0) {
          if (
            left.type !== NodeType.Identifier &&
            left.type !== NodeType.MemberExpression
          ) {
            this.error("Invalid assignment target", tok);
          }
          const op = tok.value.slice(0, -1);
          this.advance();
          const value = this.parseExpression(0);
          left = copySpan(CompoundAssignmentExpression(op, left, value), left);
          continue;
        }

        if (tok.value === "=" && minPrec <= 0) {
          if (
            left.type !== NodeType.Identifier &&
            left.type !== NodeType.MemberExpression
          ) {
            this.error("Invalid assignment target", tok);
          }
          this.advance();
          const value = this.parseExpression(0);
          left = copySpan(AssignmentExpression(left, value), left);
          continue;
        }

        if (tok.value === "?" && minPrec <= 0) {
          this.advance();
          const consequent = this.parseExpression();
          this.expect(TokenType.Punctuator, ":");
          const alternate = this.parseExpression();
          left = copySpan(ConditionalExpression(left, consequent, alternate), left);
          continue;
        }

        const prec = typeof tok.value === "string" ? PRECEDENCE[tok.value] : undefined;
        if (prec !== undefined && prec > minPrec) {
          const op = canonicalOperator(this.tokenString(tok, "operator"));
          this.advance();
          const rightPrec = op === "**" ? prec - 1 : prec;
          const right = this.parseExpression(rightPrec);
          if (op === "??") {
            left = copySpan(NullishCoalescingExpression(left, right), left);
          } else if (LOGICAL_OPS.has(op)) {
            left = copySpan(LogicalExpression(op, left, right), left);
          } else {
            left = copySpan(BinaryExpression(op, left, right), left);
          }
          continue;
        }
      }

      if (tok.type === TokenType.Keyword) {
        const prec = typeof tok.value === "string" ? PRECEDENCE[tok.value] : undefined;
        if (prec !== undefined && prec > minPrec) {
          const op = canonicalOperator(this.tokenString(tok, "operator"));
          this.advance();
          const right = this.parseExpression(prec);
          left = copySpan(LOGICAL_OPS.has(op) ? LogicalExpression(op, left, right) : BinaryExpression(op, left, right), left);
          continue;
        }
      }

      break;
    }

    return left;
  }

  parsePrimary(): ASTNode {
    const tok = this.current();
    const extension = this.parseExtensionPrefix();
    if (extension) return extension;

    if (tok.type === TokenType.Number) {
      this.advance();
      return withSpan(Literal(Number(this.tokenString(tok, "number")), "number"), tok);
    }

    if (tok.type === TokenType.String) {
      this.advance();
      return withSpan(Literal(this.tokenString(tok, "string"), "string"), tok);
    }

    if (tok.type === TokenType.RegExp) {
      this.advance();
      if (typeof tok.value !== "object" || !("pattern" in tok.value) || !("flags" in tok.value)) {
        this.error("Expected RegExp token value", tok);
      }
      return withSpan(Literal(tok.value, "regex"), tok);
    }

    if (tok.type === TokenType.TemplateLiteral) {
      this.advance();
      if (typeof tok.value !== "object" || !("parts" in tok.value) || !("expressions" in tok.value)) {
        this.error("Expected template token value", tok);
      }
      const { parts, expressions: exprSources } = tok.value;
      const exprs = exprSources.map((src: string) => {
        const lexer = new Lexer(src);
        const tokens = lexer.tokenize();
        const parser = new Parser(tokens, { syntaxPlugins: this.syntaxPlugins });
        return parser.parseExpression();
      });
      return withSpan(TemplateLiteral(parts, exprs), tok);
    }

    if (tok.type === TokenType.Keyword) {
      switch (tok.value) {
        case "true":
          this.advance();
          return withSpan(Literal(true, "boolean"), tok);
        case "false":
          this.advance();
          return withSpan(Literal(false, "boolean"), tok);
        case "null":
          this.advance();
          return withSpan(Literal(null, "null"), tok);
        case "undefined":
          this.advance();
          return withSpan(Literal(undefined, "undefined"), tok);
        case "this":
          this.advance();
          return withSpan(ThisExpression(), tok);
        case "new":
          return this.parseNewExpression();
        case "typeof": {
          this.advance();
          const argument = this.parseExpression(11);
          return withSpan(UnaryExpression("typeof", argument), tok);
        }
        case "not": {
          this.advance();
          const argument = this.parseExpression(11);
          return withSpan(UnaryExpression("!", argument), tok);
        }
        case "await": {
          this.advance();
          const argument = this.parseExpression(11);
          return withSpan(AwaitExpression(argument), tok);
        }
        case "yield": {
          this.advance();
          const delegate = this.match(TokenType.Punctuator, "*");

          let argument = null;
          if (
            !this.check(TokenType.Punctuator, ";") &&
            !this.check(TokenType.Newline) &&
            !this.check(TokenType.Punctuator, "}") &&
            !this.check(TokenType.Dedent) &&
            !this.check(TokenType.Punctuator, ")") &&
            !this.check(TokenType.Punctuator, ",") &&
            !this.isAtEnd()
          ) {
            argument = this.parseExpression(0);
          }
          return withSpan(YieldExpression(argument, delegate), tok);
        }
        case "function":
          return this.parseFunctionExpression();
        case "super": {
          this.advance();
          if (!this.check(TokenType.Punctuator, "(")) return withSpan(SuperExpression(), tok);
          this.advance();
          const args = this.parseArguments(")");
          return withSpan(SuperCallExpression(args), tok);
        }
      }
    }

    if (tok.type === TokenType.Identifier) {
      if (
        this.peek().type === TokenType.Punctuator &&
        this.peek().value === "=>"
      ) {
        return this.parseArrowFunction();
      }
      this.advance();
      return withSpan(Identifier(this.tokenString(tok, "identifier")), tok);
    }

    if (this.check(TokenType.Punctuator, "(")) {
      if (this._isArrowFunction()) {
        return this.parseArrowFunction();
      }
      this.advance();
      const expr = this.parseExpression();
      if (this.check(TokenType.Punctuator, ",")) {
        const expressions = [expr];
        while (this.check(TokenType.Punctuator, ",")) {
          this.advance();
          if (this.check(TokenType.Punctuator, ")")) break;
          expressions.push(this.parseExpression());
        }
        this.expect(TokenType.Punctuator, ")");
        return withSpan(SequenceExpression(expressions), tok);
      }
      this.expect(TokenType.Punctuator, ")");
      return expr;
    }

    if (this.check(TokenType.Punctuator, "{")) {
      return this.parseObjectExpression();
    }

    if (this.check(TokenType.Punctuator, "[")) {
      return this.parseArrayExpression();
    }

    if (this.check(TokenType.Punctuator, "!")) {
      const start = this.advance();
      const argument = this.parseExpression(11);
      return withSpan(UnaryExpression("!", argument), start);
    }

    if (this.check(TokenType.Punctuator, "-")) {
      const start = this.advance();
      const argument = this.parseExpression(11);
      return withSpan(UnaryExpression("-", argument), start);
    }

    if (this.check(TokenType.Punctuator, "+")) {
      const start = this.advance();
      const argument = this.parseExpression(11);
      return withSpan(UnaryExpression("+", argument), start);
    }

    if (this.check(TokenType.Punctuator, "~")) {
      const start = this.advance();
      const argument = this.parseExpression(11);
      return withSpan(UnaryExpression("~", argument), start);
    }

    if (
      this.check(TokenType.Punctuator, "++") ||
      this.check(TokenType.Punctuator, "--")
    ) {
      const op = this.tokenString(this.advance(), "operator");
      const argument = this.parseExpression(11);
      return withSpan(UpdateExpression(op, argument, true), tok);
    }

    if (tok.type === TokenType.Keyword && tok.value === "delete") {
      this.advance();
      const argument = this.parseExpression(11);
      return withSpan(UnaryExpression("delete", argument), tok);
    }

    this.error(`Unexpected token '${tok.value}' (${tok.type})`, tok);
  }

  private parseExtensionStatement(): StatementParseResult {
    for (const plugin of syntaxPluginsFor(this.syntaxPluginIndex.statement, this.syntaxPluginIndex.statementFallback, this.current())) {
      if (!plugin.parseStatement) continue;
      const start = this.pos;
      const result = plugin.parseStatement(this.parserContext);
      if (result !== null && result !== undefined) {
        if (this.pos === start) this.error(`Syntax plugin '${plugin.name}' produced a statement without consuming tokens`);
        return result;
      }
      if (this.pos !== start) this.error(`Syntax plugin '${plugin.name}' consumed tokens without producing a statement`);
    }
    return null;
  }

  private parseExtensionPrefix(): ASTNode | null {
    for (const plugin of syntaxPluginsFor(this.syntaxPluginIndex.prefix, this.syntaxPluginIndex.prefixFallback, this.current())) {
      if (!plugin.parseExpressionPrefix) continue;
      const start = this.pos;
      const result = plugin.parseExpressionPrefix(this.parserContext);
      if (result) {
        if (this.pos === start) this.error(`Syntax plugin '${plugin.name}' produced an expression without consuming tokens`);
        return result;
      }
      if (this.pos !== start) this.error(`Syntax plugin '${plugin.name}' consumed tokens without producing an expression`);
    }
    return null;
  }

  private parseExtensionInfix(left: ASTNode, minPrec: number): ASTNode | null {
    for (const plugin of syntaxPluginsFor(this.syntaxPluginIndex.infix, this.syntaxPluginIndex.infixFallback, this.current())) {
      if (!plugin.parseExpressionInfix) continue;
      const start = this.pos;
      const result = plugin.parseExpressionInfix(this.parserContext, left, minPrec);
      if (result) {
        if (this.pos === start) this.error(`Syntax plugin '${plugin.name}' produced an infix expression without consuming tokens`);
        return result;
      }
      if (this.pos !== start) this.error(`Syntax plugin '${plugin.name}' consumed tokens without producing an infix expression`);
    }
    return null;
  }

  parseSwitchStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "switch");
    const discriminant = this.parseControlCondition();
    this.parseBodyStart();

    const cases = [];
    this.skipStatementSeparators();
    while (!this.isBodyEnd() && !this.isAtEnd()) {
      let test = null;
      if (this.match(TokenType.Keyword, "case")) {
        test = this.parseExpression();
      } else if (!this.match(TokenType.Keyword, "default")) {
        this.error("Expected case or default", this.current());
      }

      const consequent = this.parseSwitchCaseConsequent();
      cases.push(SwitchCase(test, consequent));
      this.skipStatementSeparators();
    }

    this.parseBodyEnd();
    return withSpan(SwitchStatement(discriminant, cases), start);
  }

  parseSwitchCaseConsequent(): ASTNode[] {
    const consequent: ASTNode[] = [];
    this.expect(TokenType.Punctuator, ":");
    if (this.match(TokenType.Newline)) {
      while (this.match(TokenType.Newline)) {}
      if (!this.match(TokenType.Indent)) return consequent;
      this.skipStatementSeparators();
      while (!this.check(TokenType.Dedent) && !this.isAtEnd()) {
        const stmt = this.parseStatement();
        if (Array.isArray(stmt)) consequent.push(...stmt);
        else consequent.push(stmt);
        this.skipStatementSeparators();
      }
      this.expect(TokenType.Dedent);
      return consequent;
    }

    while (
      !this.check(TokenType.Keyword, "case") &&
      !this.check(TokenType.Keyword, "default") &&
      !this.isBodyEnd() &&
      !this.isAtEnd()
    ) {
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) consequent.push(...stmt);
      else consequent.push(stmt);
      this.skipStatementSeparators();
    }
    return consequent;
  }

  parseBreakStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "break");
    let label = null;
    if (!this.check(TokenType.Newline) && !this.check(TokenType.Dedent) && this.check(TokenType.Identifier)) {
      label = this.tokenString(this.advance(), "label");
    }
    this.consumeSemicolon();
    return withSpan({ type: NodeType.BreakStatement, label }, start);
  }

  parseDoWhileStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "do");
    const body = this.parseBlock();
    this.expect(TokenType.Keyword, "while");
    this.expect(TokenType.Punctuator, "(");
    const test = this.parseExpression();
    this.expect(TokenType.Punctuator, ")");
    this.consumeSemicolon();
    return withSpan(DoWhileStatement(test, body), start);
  }

  parseContinueStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "continue");
    let label = null;
    if (!this.check(TokenType.Newline) && !this.check(TokenType.Dedent) && this.check(TokenType.Identifier)) {
      label = this.tokenString(this.advance(), "label");
    }
    this.consumeSemicolon();
    return withSpan({ type: NodeType.ContinueStatement, label }, start);
  }

  parseTryStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "try");
    const block = this.parseBlock();

    let handler = null;
    if (this.match(TokenType.Keyword, "catch")) {
      let param = null;
      if (this.match(TokenType.Punctuator, "(")) {
        param = this.expectString(TokenType.Identifier);
        this.expect(TokenType.Punctuator, ")");
      } else if (this.check(TokenType.Identifier)) {
        param = this.expectString(TokenType.Identifier);
      }
      const body = this.parseBlock();
      handler = { param, body };
    }

    let finalizer = null;
    if (this.match(TokenType.Keyword, "finally")) {
      finalizer = this.parseBlock();
    }

    if (!handler && !finalizer) {
      this.error("Missing catch or finally after try");
    }

    return withSpan(TryStatement(block, handler, finalizer), start);
  }

  parseThrowStatement(): ASTNode {
    const start = this.expect(TokenType.Keyword, "throw");
    const argument = this.parseExpression();
    this.consumeSemicolon();
    return withSpan(ThrowStatement(argument), start);
  }

  parseClassDeclaration(): ASTNode {
    let start = this.current();
    let isAbstract = false;
    if (this.check(TokenType.Keyword, CLASS_ABSTRACT_MODIFIER)) {
      start = this.advance();
      isAbstract = true;
    }
    this.expect(TokenType.Keyword, "class");
    const classNameToken = this.expect(TokenType.Identifier);
    const className = this.tokenString(classNameToken, "class name");

    let superClass = null;
    if (this.match(TokenType.Keyword, "extends")) {
      const superName = this.expectString(TokenType.Identifier);
      superClass = Identifier(superName);
    }

    const implemented: string[] = [];
    if (this.match(TokenType.Identifier, "implements")) {
      do {
        implemented.push(this.expectString(TokenType.Identifier));
      } while (this.match(TokenType.Punctuator, ","));
    }

    this.parseBodyStart();

    let constructorNode = null;
    const methods = [];
    const fields = [];

    this.skipStatementSeparators();
    while (!this.isBodyEnd() && !this.check(TokenType.EOF)) {
      const memberStart = this.current();
      const modifiers = this.parseClassMemberModifiers();
      let memberNameToken = this.current();
      let memberName = this.classMemberName();
      let accessorKind = null;
      if (
        (memberName === "get" || memberName === "set") &&
        this.check(TokenType.Identifier)
      ) {
        accessorKind = memberName;
        const accessorNameToken = this.expect(TokenType.Identifier);
        memberName = this.tokenString(accessorNameToken, "class member name");
        memberNameToken = accessorNameToken;
      }

      if (!this.check(TokenType.Punctuator, "(")) {
        if (modifiers.isAbstract) this.error("Abstract class fields are not supported", memberStart);
        const declaredType = this.skipTypeAnnotation(new Set(["=", ";", "}"]));
        const init = this.match(TokenType.Punctuator, "=")
          ? this.parseExpression()
          : null;
        this.consumeSemicolon();
        fields.push({
          name: memberName,
          init,
          static: modifiers.isStatic,
          visibility: modifiers.visibility,
          explicitVisibility: modifiers.explicitVisibility,
          declaredType,
          __line: memberStart.line,
          __column: memberStart.column,
          __nameLine: memberNameToken.line,
          __nameColumn: memberNameToken.column,
        });
        this.skipStatementSeparators();
        continue;
      }

      const parsedParams = this._parseParamsWithInfo();
      const params = parsedParams.params;
      const returnType = this.skipReturnType() ?? "any";
      if (modifiers.isAbstract && memberName === "constructor" && !accessorKind) {
        this.error("Constructors cannot be abstract", memberStart);
      }
      if (modifiers.isAbstract && modifiers.isStatic) {
        this.error("Static class members cannot be abstract", memberStart);
      }
      const body = modifiers.isAbstract ? BlockStatement([]) : this.parseBlock();
      if (modifiers.isAbstract && this.isBodyStart()) {
        this.error("Abstract class members cannot have a body", this.current());
      }
      if (modifiers.isAbstract) this.consumeSemicolon();

      const funcNode = FunctionDeclaration(memberName, params, body);
      funcNode._paramInfo = parsedParams.info;
      funcNode._returnType = returnType;
      funcNode._typeParams = [];
      funcNode.abstract = modifiers.isAbstract;
      withNameSpan(withSpan(funcNode, memberStart), memberNameToken);

      if (memberName === "constructor" && !accessorKind && !modifiers.isStatic) {
        funcNode.visibility = modifiers.visibility;
        funcNode.explicitVisibility = modifiers.explicitVisibility;
        constructorNode = funcNode;
      } else {
        methods.push({
          name: memberName,
          func: funcNode,
          kind: accessorKind,
          static: modifiers.isStatic,
          visibility: modifiers.visibility,
          explicitVisibility: modifiers.explicitVisibility,
          abstract: modifiers.isAbstract,
        });
      }
      this.skipStatementSeparators();
    }

    this.parseBodyEnd();

    const node = ClassDeclaration(className, superClass, constructorNode, methods, fields, isAbstract);
    node.implements = implemented;
    return withNameSpan(withSpan(node, start), classNameToken);
  }

  classMemberName(): string {
    const tok = this.current();
    if (tok.type === TokenType.Identifier || tok.type === TokenType.Keyword) return this.tokenString(this.advance(), "class member name");
    this.error("Expected class member name", tok);
  }

  parseModelDeclaration(): ASTNode {
    const start = this.expect(TokenType.Keyword, "model");
    const classNameToken = this.expect(TokenType.Identifier);
    const className = this.tokenString(classNameToken, "model name");
    const parsedParams = this.check(TokenType.Punctuator, "(") ? this._parseParamsWithInfo() : { params: [], info: [] };
    this.parseBodyStart();

    const fields: ModelFieldAstNode[] = [];
    const methods = [];
    const sections: ModelSectionNode[] = [];

    this.skipStatementSeparators();
    while (!this.isBodyEnd() && !this.isAtEnd()) {
      const entryStart = this.current();
      if (!this.check(TokenType.Identifier)) {
        this.error("Expected model field or method", this.current());
      }
      const nameToken = this.expect(TokenType.Identifier);
      const name = this.tokenString(nameToken, "model member name");
      if (this.check(TokenType.Punctuator, "(")) {
        const methodParams = this._parseParamsWithInfo();
        const returnType = this.skipReturnType() ?? "any";
        const body = this.parseBlock();
        const funcNode = FunctionDeclaration(name, methodParams.params, body);
        funcNode._paramInfo = methodParams.info;
        funcNode._returnType = returnType;
        funcNode._typeParams = [];
        methods.push({ name, func: withNameSpan(withSpan(funcNode, entryStart), nameToken), kind: null });
      } else if (this.isBodyStart()) {
        const body = this.parseBlock();
        sections.push({
          name,
          body,
          __line: entryStart.line,
          __column: entryStart.column,
          __nameLine: nameToken.line,
          __nameColumn: nameToken.column,
        });
      } else {
        const declaredType = this.skipTypeAnnotation(new Set(["="]));
        this.expect(TokenType.Punctuator, "=");
        const init = this.parseExpression();
        this.consumeSemicolon();
        fields.push({
          name,
          init,
          declaredType,
          __line: entryStart.line,
          __column: entryStart.column,
          __nameLine: nameToken.line,
          __nameColumn: nameToken.column,
        });
      }
      this.skipStatementSeparators();
    }
    this.parseBodyEnd();
    const node = ModelDeclaration(className, parsedParams.params, fields, methods, sections);
    node._paramInfo = parsedParams.info;
    return withNameSpan(withSpan(node, start), classNameToken);
  }

  parseNewExpression(): ASTNode {
    const start = this.expect(TokenType.Keyword, "new");
    let callee = this.parsePrimary();

    while (this.check(TokenType.Punctuator, ".")) {
      this.advance();
      const prop = this.expectString(TokenType.Identifier);
      callee = withPropertySpan(copySpan(MemberExpression(callee, withSpan(Identifier(prop), this.tokens[this.pos - 1]), false), callee), this.tokens[this.pos - 1]);
    }

    const args = this.match(TokenType.Punctuator, "(") ? this.parseArguments(")") : [];

    return withSpan(NewExpression(callee, args), start);
  }

  parseObjectExpression(): ASTNode {
    const start = this.expect(TokenType.Punctuator, "{");
    const properties = [];

    while (!this.check(TokenType.Punctuator, "}") && !this.isAtEnd()) {
      if (this.match(TokenType.Punctuator, "...")) {
        const argument = this.parseExpression();
        properties.push({ spread: true, argument });
      } else {
        let key;
        let computed = false;
        if (this.match(TokenType.Punctuator, "[")) {
          key = this.parseExpression();
          this.expect(TokenType.Punctuator, "]");
          computed = true;
        } else if (this.check(TokenType.Identifier)) {
          key = this.tokenString(this.advance(), "property name");
        } else if (this.check(TokenType.String)) {
          key = this.tokenString(this.advance(), "property name");
        } else if (this.check(TokenType.Number)) {
          key = this.tokenString(this.advance(), "property name");
        } else {
          this.error("Expected property name", this.current());
        }

        let value;
        let kind;
        if (
          !computed &&
          (key === "get" || key === "set") &&
          !this.check(TokenType.Punctuator, "(") &&
          !this.check(TokenType.Punctuator, ":") &&
          !this.check(TokenType.Punctuator, ",") &&
          !this.check(TokenType.Punctuator, "}")
        ) {
          kind = key;
          if (this.check(TokenType.Punctuator, "[")) {
            this.advance();
            key = this.parseExpression();
            this.expect(TokenType.Punctuator, "]");
            computed = true;
          } else {
            key = this.tokenString(this.advance(), "property name");
          }
          const params = this._parseParams();
          const body = this.parseBlock();
          value = FunctionExpression(computed ? null : this.tokenStringValue(key), params, body);
        } else if (this.check(TokenType.Punctuator, "(")) {
          const params = this._parseParams();
          const body = this.parseBlock();
          const name = computed ? null : this.tokenStringValue(key);
          value = FunctionExpression(name, params, body);
        } else if (this.match(TokenType.Punctuator, ":")) {
          value = this.parseExpression();
        } else {
          value = Identifier(this.tokenStringValue(key));
        }
        properties.push({ key, value, computed, kind });
      }

      if (!this.check(TokenType.Punctuator, "}")) {
        this.expect(TokenType.Punctuator, ",");
      }
    }

    this.expect(TokenType.Punctuator, "}");
    return withSpan(ObjectExpression(properties), start);
  }

  _isArrowFunction(): boolean {
    const savedPos = this.pos;
    try {
      this.advance(); 
      let depth = 1;
      while (depth > 0 && !this.isAtEnd()) {
        const t = this.advance();
        if (t.type === TokenType.Punctuator && t.value === "(") depth++;
        else if (t.type === TokenType.Punctuator && t.value === ")") depth--;
      }
      return this.check(TokenType.Punctuator, "=>");
    } finally {
      this.pos = savedPos;
    }
  }

  parseArrowFunction(): ASTNode {
    const start = this.current();
    let params;
    if (this.check(TokenType.Identifier)) {
      params = [this.tokenString(this.advance(), "parameter")];
    } else {
      params = this._parseParams();
    }
    this.expect(TokenType.Punctuator, "=>");

    const expr = this.parseExpression();
    return withSpan(ArrowFunctionExpression(params, expr, true), start);
  }

  parseFunctionExpression(): ASTNode {
    const start = this.expect(TokenType.Keyword, "function");
    let name = null;
    if (this.check(TokenType.Identifier)) {
      name = this.tokenString(this.advance(), "function name");
    }
    const params = this._parseParams();
    const body = this.parseBlock();
    return withSpan(FunctionExpression(name, params, body), start);
  }

  parseIndexAccess(obj: ASTNode): ASTNode {
    type Dim =
      | { kind: "index"; value: ASTNode }
      | { kind: "slice"; start: ASTNode | null; stop: ASTNode | null; step: ASTNode | null };
    const dims: Dim[] = [];

    const bound = (): ASTNode | null => {
      if (this.check(TokenType.Punctuator, "]") || this.check(TokenType.Punctuator, ",") || this.check(TokenType.Punctuator, ":")) return null;
      return this.parseExpression();
    };

    do {
      const start = bound();
      if (!this.match(TokenType.Punctuator, ":")) {
        dims.push({ kind: "index", value: start ?? Literal(0, "number") });
        continue;
      }
      const stop = bound();
      const step = this.match(TokenType.Punctuator, ":") ? bound() : null;
      dims.push({ kind: "slice", start, stop, step });
    } while (this.match(TokenType.Punctuator, ","));
    this.expect(TokenType.Punctuator, "]");

    if (dims.length === 1 && dims[0].kind === "index") {
      return MemberExpression(obj, dims[0].value, true);
    }

    const elements = dims.map((dim) =>
      dim.kind === "index"
        ? IndexElementNode("index", { value: dim.value })
        : IndexElementNode("slice", { start: dim.start, stop: dim.stop, step: dim.step }),
    );
    return IndexExpression(obj, elements);
  }

  parseArrayExpression(): ASTNode {
    const start = this.expect(TokenType.Punctuator, "[");
    const elements: Array<ASTNode | null> = [];

    while (!this.check(TokenType.Punctuator, "]") && !this.isAtEnd()) {
      if (this.check(TokenType.Punctuator, ",")) {
        elements.push(null);
        this.advance();
        continue;
      }
      if (this.match(TokenType.Punctuator, "...")) {
        elements.push(SpreadElement(this.parseExpression()));
      } else {
        const element = this.parseExpression();
        if (elements.length === 0 && this.check(TokenType.Keyword, "for")) {
          return this.parseArrayComprehension(element);
        }
        elements.push(element);
      }
      if (!this.check(TokenType.Punctuator, "]")) {
        this.expect(TokenType.Punctuator, ",");
      }
    }

    this.expect(TokenType.Punctuator, "]");
    return withSpan(ArrayExpression(elements), start);
  }

  parseArrayComprehension(projection: ASTNode): ASTNode {
    this.expect(TokenType.Keyword, "for");
    const variable = this._parseBindingTarget();
    if (!this.match(TokenType.Keyword, "of") && !this.match(TokenType.Keyword, "in")) {
      this.error("Expected 'of' or 'in' in comprehension", this.current());
    }
    const iterable = this.parseExpression();

    let condition: ASTNode | null = null;
    if (this.match(TokenType.Keyword, "if")) {
      condition = this.parseExpression();
    }
    this.expect(TokenType.Punctuator, "]");

    const acc = "__comp$";
    const push = ExpressionStatement(
      CallExpression(MemberExpression(Identifier(acc), "push", false), [projection]),
    );
    const loopBody = condition
      ? IfStatement(condition, BlockStatement([push]), null)
      : BlockStatement([push]);

    const body = BlockStatement([
      LetDeclaration(acc, ArrayExpression([])),
      ForOfStatement(variable, iterable, loopBody, "let"),
      ReturnStatement(Identifier(acc)),
    ]);

    return CallExpression(ArrowFunctionExpression([], body, false), []);
  }
}

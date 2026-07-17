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
} from "../ast/index.js";

import { Lexer, TokenType, type Token, type TokenTypeName, type TokenValue } from "../lexer/index.js";

type ParserOptions = {
  lazy?: boolean;
  source?: string | null;
  depth?: number;
};
type ParserToken = Token;
type ParserNode = ASTNode;
type StatementResult = ASTNode | ASTNode[];

const PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 1,
  "&&": 2,
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

  constructor(tokens: Token[], options: ParserOptions = {}) {
    this.tokens = tokens;
    this.pos = 0;
    this.lazy = options.lazy || false;
    this.source = options.source || null;
    this.depth = options.depth || 0;
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
    if (this.check(TokenType.Punctuator, "}") || this.isAtEnd()) return;

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

  expectString(type: TokenTypeName, value?: string): string {
    return this.tokenString(this.expect(type, value), type);
  }

  tokenStringValue(value: string | ASTNode): string {
    if (typeof value !== "string") {
      this.error("Expected string property name");
    }
    return value;
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
    while (!this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) body.push(...stmt);
      else body.push(stmt);
    }
    return Program(body);
  }

  parseStatement(): StatementResult {
    const tok = this.current();

    if (tok.type === TokenType.Punctuator && tok.value === ";") {
      this.advance();
      return EmptyStatement();
    }

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
            this.peek().value === "function"
          ) {
            return this.parseFunctionDeclaration(true);
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

    if (
      tok.type === TokenType.Identifier &&
      this.peek().type === TokenType.Punctuator &&
      this.peek().value === ":"
    ) {
      const label = this.tokenString(this.advance(), "label");
      this.advance(); 
      let body = this.parseStatement();
      if (Array.isArray(body)) body = BlockStatement(body);
      return LabeledStatement(label, body);
    }

    if (
      tok.type === TokenType.Identifier &&
      this.peek().type === TokenType.Punctuator &&
      this.peek().value === "{"
    ) {
      const label = this.tokenString(this.advance(), "label");
      let body = this.parseBlock();
      if (Array.isArray(body)) body = BlockStatement(body);
      return LabeledStatement(label, body);
    }

    if (this.check(TokenType.Punctuator, "{")) {
      return this.parseBlock();
    }

    return this.parseExpressionStatement();
  }

  isTypeDeclarationStart(): boolean {
    const tok = this.current();
    return tok.type === TokenType.Identifier && (tok.value === "type" || tok.value === "interface");
  }

  parseTypeOnlyDeclaration(): ASTNode {
    const kind = this.tokenString(this.advance(), "type declaration");
    if (kind === "interface") {
      while (!this.isAtEnd() && !this.check(TokenType.Punctuator, "{") && !this.check(TokenType.Punctuator, ";")) {
        this.advance();
      }
      if (this.check(TokenType.Punctuator, "{")) this.skipBalancedBlock();
      this.match(TokenType.Punctuator, ";");
      return EmptyStatement();
    }

    let depth = 0;
    while (!this.isAtEnd()) {
      const tok = this.current();
      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
        else if (tok.value === ")" || tok.value === "]" || tok.value === "}") depth--;
        else if (depth === 0 && tok.value === ";") {
          this.advance();
          return EmptyStatement();
        }
      }
      this.advance();
    }
    return EmptyStatement();
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
    let depth = 0;
    for (let i = this.pos + 2; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
        else if (tok.value === ")" || tok.value === "]" || tok.value === "}") {
          if (depth === 0) return false;
          depth--;
        } else if (depth === 0 && tok.value === "=") {
          return true;
        } else if (depth === 0 && (tok.value === ";" || tok.value === ",")) {
          return false;
        }
      }
    }
    return false;
  }

  parseTypedAssignment(): ASTNode {
    const name = this.expectString(TokenType.Identifier);
    this.skipVariableTypeAnnotation();
    let init = null;
    if (this.match(TokenType.Punctuator, "=")) {
      init = this.parseExpression();
    }
    this.consumeSemicolon();
    return LetDeclaration(name, init);
  }

  skipVariableTypeAnnotation(): void {
    if (!this.match(TokenType.Punctuator, ":")) return;
    let depth = 0;
    while (!this.isAtEnd()) {
      const tok = this.current();
      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
        else if (tok.value === ")" || tok.value === "]" || tok.value === "}") {
          if (depth > 0) depth--;
        } else if (depth === 0 && (tok.value === "=" || tok.value === ";")) {
          break;
        }
      }
      this.advance();
    }
  }

  isDestructuringAssignmentStart(): boolean {
    if (!this.check(TokenType.Punctuator, "[") && !this.check(TokenType.Punctuator, "{")) return false;
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.type !== TokenType.Punctuator) continue;
      if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
      else if (tok.value === ")" || tok.value === "]" || tok.value === "}") depth--;
      else if (depth === 0 && tok.value === ";") return false;
      if (depth === 0 && tok.value === "=") return true;
    }
    return false;
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

  skipTypeAnnotation(stopValues = new Set<TokenValue>([",", ")", "=", "{"])): void {
    if (!this.match(TokenType.Punctuator, ":")) return;
    let depth = 0;
    while (!this.isAtEnd()) {
      const tok = this.current();
      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
        else if (tok.value === ")" || tok.value === "]" || tok.value === "}") {
          if (depth === 0 && stopValues.has(tok.value)) break;
          depth--;
        }
        if (depth === 0 && stopValues.has(tok.value)) break;
      }
      this.advance();
    }
  }

  skipReturnType(): void {
    if (!this.match(TokenType.Punctuator, "->")) return;
    let depth = 0;
    while (!this.isAtEnd()) {
      const tok = this.current();
      if (tok.type === TokenType.Punctuator) {
        if (depth <= 0 && tok.value === "{") break;
        if (tok.value === "(" || tok.value === "[" || tok.value === "{") depth++;
        else if (tok.value === ")" || tok.value === "]" || tok.value === "}") depth--;
      }
      this.advance();
    }
  }

  skipGenericParameters(): void {
    if (!this.match(TokenType.Punctuator, "<")) return;
    let depth = 1;
    while (depth > 0 && !this.isAtEnd()) {
      const tok = this.advance();
      if (tok.type !== TokenType.Punctuator) continue;
      if (tok.value === "<") depth++;
      else if (tok.value === ">") depth--;
    }
  }

  _parseParams(): ParamNode[] {
    this.expect(TokenType.Punctuator, "(");
    const params = [];
    if (!this.check(TokenType.Punctuator, ")")) {
      do {
        if (this.match(TokenType.Punctuator, "...")) {
          const name = this.expectString(TokenType.Identifier);
          params.push({ name, rest: true as const });
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
          const name = this.expectString(TokenType.Identifier);
          this.skipTypeAnnotation();
          if (this.match(TokenType.Punctuator, "=")) {
            const defaultValue = this.parseExpression();
            params.push({ name, default: defaultValue });
          } else {
            params.push(name);
          }
        }
      } while (this.match(TokenType.Punctuator, ","));
    }
    this.expect(TokenType.Punctuator, ")");
    return params;
  }

  parseFunctionDeclaration(isAsync = false, keyword = "function"): ASTNode {
    if (isAsync) this.expect(TokenType.Keyword, "async");
    this.expect(TokenType.Keyword, keyword);
    const isGenerator = this.match(TokenType.Punctuator, "*");
    const name = this.expectString(TokenType.Identifier);
    this.skipGenericParameters();

    const params = this._parseParams();
    this.skipReturnType();

    if (this.lazy && this.depth > 0) {
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
      return LazyFunctionDeclaration(
        name,
        params,
        this.source ?? "",
        bodyStartIdx,
        bodyEndIdx,
      );
    }

    this.depth++;
    const body = this.parseBlock();
    this.depth--;
    if (isGenerator) return GeneratorFunctionDeclaration(name, params, body);
    if (isAsync) return AsyncFunctionDeclaration(name, params, body);
    return FunctionDeclaration(name, params, body);
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
        const name = this.expectString(TokenType.Identifier);
        this.skipTypeAnnotation();

        let init = null;
        if (this.match(TokenType.Punctuator, "=")) {
          init = this.parseExpression();
        } else if (kind === "const") {
          throw new Error(
            `SyntaxError: Missing initializer in const declaration for '${name}'`,
          );
        }

        declarations.push(
          kind === "const"
            ? ConstDeclaration(name, init)
            : kind === "var"
              ? VarDeclaration(name, init)
              : LetDeclaration(name, init),
        );
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
      target = { kind: "id" as const, name: this.expectString(TokenType.Identifier) };
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
      const key = this.expectString(TokenType.Identifier);
      let value: BindingPattern;
      if (this.match(TokenType.Punctuator, ":")) {
        value = this._parseBindingTarget();
      } else {
        const identifier: BindingIdentifier = { kind: "id", name: key };
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
    this.expect(TokenType.Keyword, "if");
    const test = this.parseControlCondition();

    let consequent = this.parseStatementBody();
    if (Array.isArray(consequent)) consequent = BlockStatement(consequent);

    let alternate = null;

    if (this.match(TokenType.Keyword, "else")) {
      if (this.check(TokenType.Keyword, "if")) {
        alternate = this.parseIfStatement();
      } else if (this.check(TokenType.Punctuator, "{")) {
        alternate = this.parseBlock();
      } else {
        alternate = this.parseStatement();
        if (Array.isArray(alternate)) alternate = BlockStatement(alternate);
      }
    }

    return IfStatement(test, consequent, alternate);
  }

  parseWhileStatement(): ASTNode {
    this.expect(TokenType.Keyword, "while");
    const test = this.parseControlCondition();

    let body = this.parseStatementBody();
    if (Array.isArray(body)) body = BlockStatement(body);
    return WhileStatement(test, body);
  }

  parseForStatement(): ASTNode {
    this.expect(TokenType.Keyword, "for");
    if (!this.check(TokenType.Punctuator, "(")) {
      const target = this._parseBindingTarget();
      if (
        !this.check(TokenType.Keyword) ||
        (this.current().value !== "in" && this.current().value !== "of")
      ) {
        this.error("Expected 'in' or 'of' in for statement");
      }
      const kind = this.tokenString(this.advance(), "for-kind");
      const binding =
        this.isBindingIdentifier(target) && target.default === undefined
          ? target.name
          : target;
      const expr = this.parseExpression();
      let body = this.parseStatementBody();
      if (Array.isArray(body)) body = BlockStatement(body);
      return kind === "in"
        ? ForInStatement(binding, expr, body, "let")
        : ForOfStatement(binding, expr, body, "let");
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
          const binding =
            this.isBindingIdentifier(target) && target.default === undefined
              ? target.name
              : target;
          const expr = this.parseExpression();
          this.expect(TokenType.Punctuator, ")");
          let body = this.check(TokenType.Punctuator, "{")
            ? this.parseBlock()
            : this.parseStatement();
          if (Array.isArray(body)) body = BlockStatement(body);
          if (kind === "in") {
            return ForInStatement(binding, expr, body, declKind);
          } else {
            return ForOfStatement(binding, expr, body, declKind);
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

    let body = this.check(TokenType.Punctuator, "{")
      ? this.parseBlock()
      : this.parseStatement();
    if (Array.isArray(body)) body = BlockStatement(body);
    return ForStatement(init, test, update, body);
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
    return this.check(TokenType.Punctuator, "{")
      ? this.parseBlock()
      : this.parseStatement();
  }

  parseReturnStatement(): ASTNode {
    this.expect(TokenType.Keyword, "return");

    let argument = null;
    if (
      !this.check(TokenType.Punctuator, ";") &&
      !this.check(TokenType.Punctuator, "}") &&
      !this.isAtEnd()
    ) {
      argument = this.parseExpression();
    }

    this.consumeSemicolon();
    return ReturnStatement(argument);
  }

  parseBlock(): ASTNode {
    this.expect(TokenType.Punctuator, "{");
    const body = [];
    while (!this.check(TokenType.Punctuator, "}") && !this.isAtEnd()) {
      const stmt = this.parseStatement();
      if (Array.isArray(stmt)) body.push(...stmt);
      else body.push(stmt);
    }
    this.expect(TokenType.Punctuator, "}");
    return BlockStatement(body);
  }

  parseExpressionStatement(): ASTNode {
    const expression = this.parseExpression();
    this.consumeSemicolon();
    return ExpressionStatement(expression);
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
          const name = this.expectString(TokenType.Identifier);
          this.expect(TokenType.Punctuator, "=");
          args.push(NamedArgument(name, this.parseExpression()));
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
      } else if (depth === 0 || tok.value === ";" || tok.value === "{") {
        return false;
      }
    }
    return false;
  }

  parseExpression(minPrec = 0): ASTNode {
    let left = this.parsePrimary();

    while (true) {
      const tok = this.current();

      if (tok.type === TokenType.Punctuator) {
        if (tok.value === "<" && minPrec <= 12 && this.isGenericCallAhead()) {
          this.skipGenericParameters();
          continue;
        }

        if (tok.value === "." && minPrec <= 12) {
          this.advance();
          const prop =
            this.check(TokenType.Identifier) || this.check(TokenType.Keyword)
              ? this.advance()
              : this.expect(TokenType.Identifier);
          left = MemberExpression(left, this.tokenString(prop, "property"), false);
          continue;
        }

        if (tok.value === "?." && minPrec <= 12) {
          this.advance();
          if (this.check(TokenType.Punctuator, "(")) {
            this.advance();
            const args = this.parseArguments(")");
            left = OptionalCallExpression(left, args);
          } else if (this.check(TokenType.Punctuator, "[")) {
            this.advance();
            const index = this.parseExpression();
            this.expect(TokenType.Punctuator, "]");
            left = OptionalMemberExpression(left, index, true);
          } else {
            const prop =
              this.check(TokenType.Identifier) || this.check(TokenType.Keyword)
                ? this.advance()
                : this.expect(TokenType.Identifier);
            left = OptionalMemberExpression(left, this.tokenString(prop, "property"), false);
          }
          continue;
        }

        if (tok.value === "(" && minPrec <= 12) {
          this.advance();
          const args = this.parseArguments(")");
          left = CallExpression(left, args);
          continue;
        }

        if (tok.value === "[" && minPrec <= 12) {
          this.advance();
          const index = this.parseExpression();
          this.expect(TokenType.Punctuator, "]");
          left = MemberExpression(left, index, true);
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
          left = UpdateExpression(this.tokenString(tok, "operator"), left, false);
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
          left = CompoundAssignmentExpression(op, left, value);
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
          left = AssignmentExpression(left, value);
          continue;
        }

        if (tok.value === "?" && minPrec <= 0) {
          this.advance();
          const consequent = this.parseExpression();
          this.expect(TokenType.Punctuator, ":");
          const alternate = this.parseExpression();
          left = ConditionalExpression(left, consequent, alternate);
          continue;
        }

        const prec = typeof tok.value === "string" ? PRECEDENCE[tok.value] : undefined;
        if (prec !== undefined && prec > minPrec) {
          const op = this.tokenString(tok, "operator");
          this.advance();
          const rightPrec = op === "**" ? prec - 1 : prec;
          const right = this.parseExpression(rightPrec);
          if (op === "??") {
            left = NullishCoalescingExpression(left, right);
          } else if (LOGICAL_OPS.has(op)) {
            left = LogicalExpression(op, left, right);
          } else {
            left = BinaryExpression(op, left, right);
          }
          continue;
        }
      }

      if (tok.type === TokenType.Keyword) {
        const prec = typeof tok.value === "string" ? PRECEDENCE[tok.value] : undefined;
        if (prec !== undefined && prec > minPrec) {
          const op = this.tokenString(tok, "operator");
          this.advance();
          const right = this.parseExpression(prec);
          left = BinaryExpression(op, left, right);
          continue;
        }
      }

      break;
    }

    return left;
  }

  parsePrimary(): ASTNode {
    const tok = this.current();

    if (tok.type === TokenType.Number) {
      this.advance();
      return Literal(Number(this.tokenString(tok, "number")), "number");
    }

    if (tok.type === TokenType.String) {
      this.advance();
      return Literal(this.tokenString(tok, "string"), "string");
    }

    if (tok.type === TokenType.RegExp) {
      this.advance();
      if (typeof tok.value !== "object" || !("pattern" in tok.value) || !("flags" in tok.value)) {
        this.error("Expected RegExp token value", tok);
      }
      return Literal(tok.value, "regex");
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
        const parser = new Parser(tokens);
        return parser.parseExpression();
      });
      return TemplateLiteral(parts, exprs);
    }

    if (tok.type === TokenType.Keyword) {
      switch (tok.value) {
        case "true":
          this.advance();
          return Literal(true, "boolean");
        case "false":
          this.advance();
          return Literal(false, "boolean");
        case "null":
          this.advance();
          return Literal(null, "null");
        case "undefined":
          this.advance();
          return Literal(undefined, "undefined");
        case "this":
          this.advance();
          return ThisExpression();
        case "new":
          return this.parseNewExpression();
        case "typeof": {
          this.advance();
          const argument = this.parseExpression(11);
          return UnaryExpression("typeof", argument);
        }
        case "await": {
          this.advance();
          const argument = this.parseExpression(11);
          return AwaitExpression(argument);
        }
        case "yield": {
          this.advance();
          const delegate = this.match(TokenType.Punctuator, "*");

          let argument = null;
          if (
            !this.check(TokenType.Punctuator, ";") &&
            !this.check(TokenType.Punctuator, "}") &&
            !this.check(TokenType.Punctuator, ")") &&
            !this.check(TokenType.Punctuator, ",") &&
            !this.isAtEnd()
          ) {
            argument = this.parseExpression(0);
          }
          return YieldExpression(argument, delegate);
        }
        case "function":
          return this.parseFunctionExpression();
        case "super": {
          this.advance();
          if (!this.check(TokenType.Punctuator, "(")) return SuperExpression();
          this.advance();
          const args = this.parseArguments(")");
          return SuperCallExpression(args);
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
      return Identifier(this.tokenString(tok, "identifier"));
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
        return SequenceExpression(expressions);
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
      this.advance();
      const argument = this.parseExpression(11);
      return UnaryExpression("!", argument);
    }

    if (this.check(TokenType.Punctuator, "-")) {
      this.advance();
      const argument = this.parseExpression(11);
      return UnaryExpression("-", argument);
    }

    if (this.check(TokenType.Punctuator, "+")) {
      this.advance();
      const argument = this.parseExpression(11);
      return UnaryExpression("+", argument);
    }

    if (this.check(TokenType.Punctuator, "~")) {
      this.advance();
      const argument = this.parseExpression(11);
      return UnaryExpression("~", argument);
    }

    if (
      this.check(TokenType.Punctuator, "++") ||
      this.check(TokenType.Punctuator, "--")
    ) {
      const op = this.tokenString(this.advance(), "operator");
      const argument = this.parseExpression(11);
      return UpdateExpression(op, argument, true);
    }

    if (tok.type === TokenType.Keyword && tok.value === "void") {
      this.advance();
      const argument = this.parseExpression(11);
      return UnaryExpression("void", argument);
    }

    if (tok.type === TokenType.Keyword && tok.value === "delete") {
      this.advance();
      const argument = this.parseExpression(11);
      return UnaryExpression("delete", argument);
    }

    this.error(`Unexpected token '${tok.value}' (${tok.type})`, tok);
  }

  parseSwitchStatement(): ASTNode {
    this.expect(TokenType.Keyword, "switch");
    this.expect(TokenType.Punctuator, "(");
    const discriminant = this.parseExpression();
    this.expect(TokenType.Punctuator, ")");
    this.expect(TokenType.Punctuator, "{");

    const cases = [];
    while (!this.check(TokenType.Punctuator, "}") && !this.isAtEnd()) {
      let test = null;
      if (this.match(TokenType.Keyword, "case")) {
        test = this.parseExpression();
        this.expect(TokenType.Punctuator, ":");
      } else if (this.match(TokenType.Keyword, "default")) {
        this.expect(TokenType.Punctuator, ":");
      } else {
        this.error("Expected case or default", this.current());
      }

      const consequent = [];
      while (
        !this.check(TokenType.Keyword, "case") &&
        !this.check(TokenType.Keyword, "default") &&
        !this.check(TokenType.Punctuator, "}") &&
        !this.isAtEnd()
      ) {
          const stmt = this.parseStatement();
          if (Array.isArray(stmt)) consequent.push(...stmt);
          else consequent.push(stmt);
      }
      cases.push(SwitchCase(test, consequent));
    }

    this.expect(TokenType.Punctuator, "}");
    return SwitchStatement(discriminant, cases);
  }

  parseBreakStatement(): ASTNode {
    this.expect(TokenType.Keyword, "break");
    let label = null;
    if (this.check(TokenType.Identifier)) {
      label = this.tokenString(this.advance(), "label");
    }
    this.consumeSemicolon();
    return { type: NodeType.BreakStatement, label };
  }

  parseDoWhileStatement(): ASTNode {
    this.expect(TokenType.Keyword, "do");
    const body = this.parseBlock();
    this.expect(TokenType.Keyword, "while");
    this.expect(TokenType.Punctuator, "(");
    const test = this.parseExpression();
    this.expect(TokenType.Punctuator, ")");
    this.consumeSemicolon();
    return DoWhileStatement(test, body);
  }

  parseContinueStatement(): ASTNode {
    this.expect(TokenType.Keyword, "continue");
    let label = null;
    if (this.check(TokenType.Identifier)) {
      label = this.tokenString(this.advance(), "label");
    }
    this.consumeSemicolon();
    return { type: NodeType.ContinueStatement, label };
  }

  parseTryStatement(): ASTNode {
    this.expect(TokenType.Keyword, "try");
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

    return TryStatement(block, handler, finalizer);
  }

  parseThrowStatement(): ASTNode {
    this.expect(TokenType.Keyword, "throw");
    const argument = this.parseExpression();
    this.consumeSemicolon();
    return ThrowStatement(argument);
  }

  parseClassDeclaration(): ASTNode {
    this.expect(TokenType.Keyword, "class");
    const className = this.expectString(TokenType.Identifier);

    let superClass = null;
    if (this.match(TokenType.Keyword, "extends")) {
      const superName = this.expectString(TokenType.Identifier);
      superClass = Identifier(superName);
    }

    this.expect(TokenType.Punctuator, "{");

    let constructorNode = null;
    const methods = [];

    while (
      !this.check(TokenType.Punctuator, "}") &&
      !this.check(TokenType.EOF)
    ) {
      let accessorKind = null;
      const firstIdent = this.expect(TokenType.Identifier);
      const firstName = this.tokenString(firstIdent, "method name");
      let methodName;
      if (
        (firstName === "get" || firstName === "set") &&
        this.check(TokenType.Identifier)
      ) {
        accessorKind = firstName;
        methodName = this.expectString(TokenType.Identifier);
      } else {
        methodName = firstName;
      }
      const params = this._parseParams();
      this.skipReturnType();
      const body = this.parseBlock();

      const funcNode = FunctionDeclaration(methodName, params, body);

      if (methodName === "constructor" && !accessorKind) {
        constructorNode = funcNode;
      } else {
        methods.push({
          name: methodName,
          func: funcNode,
          kind: accessorKind,
        });
      }
    }

    this.expect(TokenType.Punctuator, "}");

    return ClassDeclaration(className, superClass, constructorNode, methods);
  }

  parseModelDeclaration(): ASTNode {
    this.expect(TokenType.Keyword, "model");
    const className = this.expectString(TokenType.Identifier);
    const params = this.check(TokenType.Punctuator, "(") ? this._parseParams() : [];
    this.expect(TokenType.Punctuator, "{");

    const fields: Array<{ name: string; init: ASTNode }> = [];
    const methods = [];
    const methodNames = new Set<string>();

    while (!this.check(TokenType.Punctuator, "}") && !this.isAtEnd()) {
      if (!this.check(TokenType.Identifier)) {
        this.error("Expected model field or method", this.current());
      }
      const name = this.expectString(TokenType.Identifier);
      if (this.check(TokenType.Punctuator, "(")) {
        const methodParams = this._parseParams();
        this.skipReturnType();
        const body = this.parseBlock();
        const funcNode = FunctionDeclaration(name, methodParams, this.rewriteModelFieldRefs(body, () => new Set(fields.map((field) => field.name))));
        methods.push({ name, func: funcNode, kind: null });
        methodNames.add(name);
      } else {
        this.skipTypeAnnotation(new Set<TokenValue>(["="]));
        this.expect(TokenType.Punctuator, "=");
        const init = this.parseExpression();
        this.consumeSemicolon();
        fields.push({ name, init });
      }
    }
    this.expect(TokenType.Punctuator, "}");

    const ctorBody = fields.map((field) =>
      ExpressionStatement(
        AssignmentExpression(
          MemberExpression(ThisExpression(), field.name, false),
          field.init,
        ),
      ),
    );
    const constructorNode = params.length || ctorBody.length
      ? FunctionDeclaration("constructor", params, BlockStatement(ctorBody.length ? ctorBody : [ExpressionStatement(Literal(null, "null"))]))
      : null;

    const helperMethod = (name: string, params: ParamNode[], callName: string, args: ASTNode[]) => {
      if (methodNames.has(name)) return;
      methods.push({
        name,
        kind: null,
        func: FunctionDeclaration(name, params, BlockStatement([
          ReturnStatement(CallExpression(Identifier(callName), args)),
        ])),
      });
    };

    helperMethod("parameters", [], "model_parameters", [ThisExpression()]);
    helperMethod("train", ["mode"], "model_train", [ThisExpression(), Identifier("mode")]);
    helperMethod("validate", ["data", "target", "loss_fn"], "model_validate", [ThisExpression(), Identifier("data"), Identifier("target"), Identifier("loss_fn")]);
    helperMethod("optimizer", ["kind", "lr"], "model_optimizer", [ThisExpression(), Identifier("kind"), NamedArgument("lr", Identifier("lr"))]);
    helperMethod("is_training", [], "is_model_training", [ThisExpression()]);

    return ClassDeclaration(className, null, constructorNode, methods);
  }

  rewriteModelFieldRefs(node: ASTNode, fieldNames: () => Set<string>): ASTNode {
    const fields = fieldNames();
    const visit = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(visit);
      if (!value || typeof value !== "object" || !("type" in value)) return value;
      const current = value as ASTNode;
      if (current.type === NodeType.Identifier && typeof current.name === "string" && fields.has(current.name)) {
        return MemberExpression(ThisExpression(), current.name, false);
      }
      const next: ASTNode = { ...current };
      for (const key of Object.keys(next)) {
        if (key === "type") continue;
        next[key] = visit(next[key]) as never;
      }
      return next;
    };
    return visit(node) as ASTNode;
  }

  parseNewExpression(): ASTNode {
    this.expect(TokenType.Keyword, "new");
    let callee = this.parsePrimary();

    while (this.check(TokenType.Punctuator, ".")) {
      this.advance();
      const prop = this.expectString(TokenType.Identifier);
      callee = MemberExpression(callee, Identifier(prop), false);
    }

    const args = this.match(TokenType.Punctuator, "(") ? this.parseArguments(")") : [];

    return NewExpression(callee, args);
  }

  parseObjectExpression(): ASTNode {
    this.expect(TokenType.Punctuator, "{");
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
    return ObjectExpression(properties);
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
    let params;
    if (this.check(TokenType.Identifier)) {
      params = [this.tokenString(this.advance(), "parameter")];
    } else {
      params = this._parseParams();
    }
    this.expect(TokenType.Punctuator, "=>");

    if (this.check(TokenType.Punctuator, "{")) {
      const body = this.parseBlock();
      return ArrowFunctionExpression(params, body, false);
    }
    const expr = this.parseExpression();
    return ArrowFunctionExpression(params, expr, true);
  }

  parseFunctionExpression(): ASTNode {
    this.expect(TokenType.Keyword, "function");
    let name = null;
    if (this.check(TokenType.Identifier)) {
      name = this.tokenString(this.advance(), "function name");
    }
    const params = this._parseParams();
    const body = this.parseBlock();
    return FunctionExpression(name, params, body);
  }

  parseArrayExpression(): ASTNode {
    this.expect(TokenType.Punctuator, "[");
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
        elements.push(this.parseExpression());
      }
      if (!this.check(TokenType.Punctuator, "]")) {
        this.expect(TokenType.Punctuator, ",");
      }
    }

    this.expect(TokenType.Punctuator, "]");
    return ArrayExpression(elements);
  }
}

export function parse(source: string, options: ParserOptions = {}): ASTNode {
  const lexer = new Lexer(source);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, {
    ...options,
    source: options.lazy ? source : null,
  });
  return parser.parse();
}

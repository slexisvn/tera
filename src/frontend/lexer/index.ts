export const TokenType = {
  Number: "Number",
  String: "String",
  Identifier: "Identifier",
  Keyword: "Keyword",
  Punctuator: "Punctuator",
  RegExp: "RegExp",
  TemplateLiteral: "TemplateLiteral",
  EOF: "EOF",
} as const;

export type TokenTypeName = (typeof TokenType)[keyof typeof TokenType];
export type RegExpTokenValue = { pattern: string; flags: string };
export type TemplateLiteralTokenValue = {
  parts: string[];
  expressions: string[];
};
export type TokenValue = string | RegExpTokenValue | TemplateLiteralTokenValue;
export type Token = {
  type: TokenTypeName;
  value: TokenValue;
  line: number;
  column: number;
};

export const KEYWORDS = new Set([
  "let",
  "const",
  "var",
  "function",
  "if",
  "else",
  "while",
  "for",
  "do",
  "return",
  "true",
  "false",
  "null",
  "undefined",
  "new",
  "this",
  "typeof",
  "instanceof",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "class",
  "extends",
  "super",
  "in",
  "of",
  "async",
  "await",
  "yield",
  "delete",
  "void",
  "fn",
  "model",
  "and",
  "or",
  "not",
]);

const MULTI_CHAR_PUNCTUATORS = [
  ">>>=",
  "**=",
  "...",
  "===",
  "!==",
  ">>>",
  "<<=",
  ">>=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "**",
  "<<",
  ">>",
  "=>",
  "->",
];

const SINGLE_CHAR_PUNCTUATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "=",
  ".",
  ",",
  ";",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ":",
  "?",
  "@",
  "&",
  "|",
  "^",
  "~",
]);

function makeToken(
  type: TokenTypeName,
  value: TokenValue,
  line: number,
  column: number,
): Token {
  return { type, value, line, column };
}

function decodeEscape(esc: string): string {
  switch (esc) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "\\":
      return "\\";
    default:
      return esc;
  }
}

export class Lexer {
  source: string;
  pos: number;
  line: number;
  column: number;
  length: number;
  lastToken: Token | null;

  constructor(source: string) {
    this.source = source;
    this.pos = 0;
    this.line = 1;
    this.column = 1;
    this.length = source.length;
    this.lastToken = null;
  }

  peek(): string {
    return this.pos < this.length ? this.source[this.pos] : "\0";
  }

  peekAhead(n = 1): string {
    const idx = this.pos + n;
    return idx < this.length ? this.source[idx] : "\0";
  }

  advance(): string {
    const ch = this.source[this.pos];
    this.pos++;
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  match(expected: string): boolean {
    if (this.peek() === expected) {
      this.advance();
      return true;
    }
    return false;
  }

  isAtEnd(): boolean {
    return this.pos >= this.length;
  }

  skipWhitespaceAndComments(): void {
    while (!this.isAtEnd()) {
      const ch = this.peek();

      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }

      if (ch === "/" && this.peekAhead() === "/") {
        this.advance();
        this.advance();
        while (!this.isAtEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }

      if (ch === "#") {
        while (!this.isAtEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }

      if (ch === "/" && this.peekAhead() === "*") {
        this.advance();
        this.advance();
        while (
          !this.isAtEnd() &&
          !(this.peek() === "*" && this.peekAhead() === "/")
        ) {
          this.advance();
        }
        if (!this.isAtEnd()) {
          this.advance();
          this.advance();
        }
        continue;
      }

      break;
    }
  }

  scanNumber(): Token {
    const startLine = this.line;
    const startCol = this.column;
    let value = "";

    const first = this.advance();
    value += first;

    
    if (first === "0" && !this.isAtEnd()) {
      const next = this.peek();
      if (next === "x" || next === "X") {
        value += this.advance(); 
        while (
          !this.isAtEnd() &&
          (isHexDigit(this.peek()) || this.peek() === "_")
        ) {
          const c = this.advance();
          if (c !== "_") value += c;
        }
        return makeToken(TokenType.Number, value, startLine, startCol);
      }
      if (next === "b" || next === "B") {
        value += this.advance(); 
        while (
          !this.isAtEnd() &&
          (this.peek() === "0" || this.peek() === "1" || this.peek() === "_")
        ) {
          const c = this.advance();
          if (c !== "_") value += c;
        }
        return makeToken(TokenType.Number, value, startLine, startCol);
      }
      if (next === "o" || next === "O") {
        value += this.advance(); 
        while (
          !this.isAtEnd() &&
          ((this.peek() >= "0" && this.peek() <= "7") || this.peek() === "_")
        ) {
          const c = this.advance();
          if (c !== "_") value += c;
        }
        return makeToken(TokenType.Number, value, startLine, startCol);
      }
    }

    
    while (!this.isAtEnd() && (isDigit(this.peek()) || this.peek() === "_")) {
      const c = this.advance();
      if (c !== "_") value += c;
    }

    
    
    if (this.peek() === "." && this.peekAhead() !== ".") {
      value += this.advance();
      while (!this.isAtEnd() && (isDigit(this.peek()) || this.peek() === "_")) {
        const c = this.advance();
        if (c !== "_") value += c;
      }
    }

    
    if (!this.isAtEnd() && (this.peek() === "e" || this.peek() === "E")) {
      value += this.advance(); 
      if (!this.isAtEnd() && (this.peek() === "+" || this.peek() === "-")) {
        value += this.advance(); 
      }
      while (!this.isAtEnd() && isDigit(this.peek())) {
        value += this.advance();
      }
    }

    return makeToken(TokenType.Number, value, startLine, startCol);
  }

  scanQuotedString(quote: '"' | "'"): Token {
    const startLine = this.line;
    const startCol = this.column;

    this.advance();
    let value = "";

    while (!this.isAtEnd() && this.peek() !== quote) {
      if (this.peek() === "\\") {
        this.advance();
        const esc = this.advance();
        value += decodeEscape(esc);
      } else {
        value += this.advance();
      }
    }

    if (this.isAtEnd()) {
      this.error("Unterminated string literal", startLine, startCol);
    }

    this.advance();
    return makeToken(TokenType.String, value, startLine, startCol);
  }

  scanTemplateLiteral(): Token {
    const startLine = this.line;
    const startCol = this.column;
    this.advance();
    const parts: string[] = [];
    const expressions: string[] = [];
    let current = "";

    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === "`") {
        this.advance();
        parts.push(current);
        return makeToken(
          TokenType.TemplateLiteral,
          { parts, expressions },
          startLine,
          startCol,
        );
      }
      if (ch === "$" && this.peekAhead() === "{") {
        parts.push(current);
        current = "";
        this.advance();
        this.advance();
        let depth = 1;
        let exprSource = "";
        while (!this.isAtEnd() && depth > 0) {
          const c = this.peek();
          if (c === "{") depth++;
          else if (c === "}") {
            depth--;
            if (depth === 0) {
              this.advance();
              break;
            }
          }
          exprSource += this.advance();
        }
        expressions.push(exprSource);
        continue;
      }
      if (ch === "\\") {
        this.advance();
        const esc = this.advance();
        current += decodeEscape(esc);
        continue;
      }
      current += this.advance();
    }
    this.error("Unterminated template literal", startLine, startCol);
  }

  scanIdentifier(): Token {
    const startLine = this.line;
    const startCol = this.column;
    let value = "";

    while (!this.isAtEnd() && isIdentChar(this.peek())) {
      value += this.advance();
    }

    const type = KEYWORDS.has(value) ? TokenType.Keyword : TokenType.Identifier;
    return makeToken(type, value, startLine, startCol);
  }

  canStartRegex(): boolean {
    if (!this.lastToken) return true;
    if (
      this.lastToken.type === TokenType.Number ||
      this.lastToken.type === TokenType.String
    )
      return false;
    if (this.lastToken.type === TokenType.Identifier) return false;
    if (this.lastToken.type === TokenType.Keyword) {
      const v = this.lastToken.value;
      if (
        v === "true" ||
        v === "false" ||
        v === "null" ||
        v === "undefined" ||
        v === "this"
      )
        return false;
      return true;
    }
    if (this.lastToken.type === TokenType.Punctuator) {
      const v = this.lastToken.value;
      if (v === ")" || v === "]") return false;
      return true;
    }
    return true;
  }

  scanRegex(): Token {
    const startLine = this.line;
    const startCol = this.column;
    this.advance();
    let pattern = "";
    let inCharClass = false;
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === "\\") {
        pattern += this.advance();
        if (!this.isAtEnd()) pattern += this.advance();
        continue;
      }
      if (inCharClass) {
        if (ch === "]") inCharClass = false;
        pattern += this.advance();
        continue;
      }
      if (ch === "[") {
        inCharClass = true;
        pattern += this.advance();
        continue;
      }
      if (ch === "/") {
        this.advance();
        break;
      }
      if (ch === "\n") {
        this.error("Unterminated regex literal", startLine, startCol);
      }
      pattern += this.advance();
    }
    let flags = "";
    while (!this.isAtEnd() && isIdentChar(this.peek())) {
      flags += this.advance();
    }
    return makeToken(TokenType.RegExp, { pattern, flags }, startLine, startCol);
  }

  scanPunctuator(): Token {
    const startLine = this.line;
    const startCol = this.column;

    for (const punct of MULTI_CHAR_PUNCTUATORS) {
      if (this.source.startsWith(punct, this.pos)) {
        for (let i = 0; i < punct.length; i++) {
          this.advance();
        }
        return makeToken(TokenType.Punctuator, punct, startLine, startCol);
      }
    }

    const ch = this.peek();
    if (SINGLE_CHAR_PUNCTUATORS.has(ch)) {
      this.advance();
      return makeToken(TokenType.Punctuator, ch, startLine, startCol);
    }

    this.error(`Unexpected character '${ch}'`, startLine, startCol);
  }

  nextToken(): Token {
    this.skipWhitespaceAndComments();

    if (this.isAtEnd()) {
      return makeToken(TokenType.EOF, "", this.line, this.column);
    }

    const ch = this.peek();
    let token: Token;

    if (isDigit(ch) || (ch === "." && isDigit(this.peekAhead()))) {
      token = this.scanNumber();
    } else if (ch === '"') {
      token = this.scanQuotedString('"');
    } else if (ch === "'") {
      token = this.scanQuotedString("'");
    } else if (ch === "`") {
      token = this.scanTemplateLiteral();
    } else if (isIdentStart(ch)) {
      token = this.scanIdentifier();
    } else if (ch === "/" && this.canStartRegex()) {
      token = this.scanRegex();
    } else {
      token = this.scanPunctuator();
    }

    this.lastToken = token;
    return token;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (true) {
      const token = this.nextToken();
      tokens.push(token);
      if (token.type === TokenType.EOF) break;
    }
    return tokens;
  }

  error(message: string, line?: number, column?: number): never {
    throw new SyntaxError(
      `[Lexer] ${message} at ${line ?? this.line}:${column ?? this.column}`,
    );
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}

function isIdentStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "$"
  );
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

import { Lexer, TokenType, type Token, type TokenValue } from "../lexer/index.js";

function punct(value: string, line: number, column: number): Token {
  return { type: TokenType.Punctuator, value, line, column };
}

function token(type: Token["type"], value: TokenValue, line: number, column: number): Token {
  return { type, value, line, column };
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count++;
  return count;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//");
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

function tokenizeFragment(source: string, line: number, column: number): Token[] {
  const lexer = new Lexer(source);
  const raw = lexer.tokenize().filter((tok) => tok.type !== TokenType.EOF);
  return raw.map((tok) => token(tok.type, tok.value, line + tok.line - 1, tok.line === 1 ? column + tok.column - 1 : tok.column));
}

function mapKeyword(tok: Token): Token {
  if (tok.type !== TokenType.Keyword) return tok;
  if (tok.value === "and") return { ...tok, type: TokenType.Punctuator, value: "&&" };
  if (tok.value === "or") return { ...tok, type: TokenType.Punctuator, value: "||" };
  if (tok.value === "not") return { ...tok, type: TokenType.Punctuator, value: "!" };
  return tok;
}

export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  const indents = [0];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let delimiterDepth = 0;
  let pendingBlock: Token | null = null;
  let lastLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    lastLine = lineNo;
    if (isBlankOrComment(raw)) continue;

    const indent = leadingSpaces(raw);
    const text = raw.slice(indent).trimEnd();
    const lineTokens = tokenizeFragment(text, lineNo, indent + 1).map(mapKeyword);

    if (delimiterDepth === 0) {
      if (pendingBlock) {
        if (indent <= indents[indents.length - 1]) {
          const virtualIndent = indents[indents.length - 1] + 2;
          indents.push(virtualIndent);
        } else {
          indents.push(indent);
        }
        out.push(punct("{", pendingBlock.line, pendingBlock.column));
        pendingBlock = null;
      } else {
        while (indents.length > 1 && indent < indents[indents.length - 1]) {
          indents.pop();
          out.push(punct("}", lineNo, indent + 1));
        }
      }
    }

    const endsBlock = delimiterDepth === 0 && lineTokens.at(-1)?.type === TokenType.Punctuator && lineTokens.at(-1)?.value === ":";
    if (endsBlock) lineTokens.pop();
    out.push(...lineTokens);
    delimiterDepth += delimiterDelta(lineTokens);

    if (endsBlock) {
      pendingBlock = punct("{", lineNo, raw.length + 1);
    } else if (delimiterDepth === 0) {
      out.push(punct(";", lineNo, raw.length + 1));
    }
    if (delimiterDepth < 0) delimiterDepth = 0;
  }

  while (indents.length > 1) {
    indents.pop();
    out.push(punct("}", lastLine, 1));
  }
  out.push({ type: TokenType.EOF, value: "", line: lastLine + 1, column: 1 });
  return out;
}

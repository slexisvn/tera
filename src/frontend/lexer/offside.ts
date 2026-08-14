import { Lexer, TokenType, type Token, type TokenValue } from "../lexer/index.js";

function token(type: Token["type"], value: TokenValue, line: number, column: number): Token {
  return { type, value, line, column };
}

function layout(type: typeof TokenType.Newline | typeof TokenType.Indent | typeof TokenType.Dedent, line: number, column: number): Token {
  return { type, value: "", line, column };
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

function continuesMemberChain(lines: string[], from: number): boolean {
  for (let j = from + 1; j < lines.length; j++) {
    if (isBlankOrComment(lines[j])) continue;
    return /^(\?\.|\.)\s*[A-Za-z_$]/.test(lines[j].trim());
  }
  return false;
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

export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  const indents = [0];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let delimiterDepth = 0;
  let pendingBlock: Token | null = null;
  let lastLine = 1;
  let baseIndentSet = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    lastLine = lineNo;
    if (isBlankOrComment(raw)) continue;

    const indent = leadingSpaces(raw);
    const text = raw.slice(indent).trimEnd();
    const lineTokens = tokenizeFragment(text, lineNo, indent + 1);

    if (!baseIndentSet) {
      indents[0] = indent;
      baseIndentSet = true;
    }

    if (delimiterDepth === 0) {
      if (pendingBlock) {
        if (indent > indents[indents.length - 1]) {
          indents.push(indent);
          out.push(layout(TokenType.Indent, lineNo, indent + 1));
        }
        pendingBlock = null;
      } else {
        let dedented = false;
        while (indents.length > 1 && indent < indents[indents.length - 1]) {
          indents.pop();
          out.push(layout(TokenType.Dedent, lineNo, indent + 1));
          dedented = true;
        }
        if (dedented && indent !== indents[indents.length - 1]) {
          throw new SyntaxError(
            `[Lexer] unindent does not match any outer indentation level at ${lineNo}:${indent + 1}`,
          );
        }
      }
    }

    const endsBlock = delimiterDepth === 0 && lineTokens.at(-1)?.type === TokenType.Punctuator && lineTokens.at(-1)?.value === ":";
    out.push(...lineTokens);
    delimiterDepth += delimiterDelta(lineTokens);

    if (endsBlock) {
      pendingBlock = lineTokens[lineTokens.length - 1] ?? null;
      out.push(layout(TokenType.Newline, lineNo, raw.length + 1));
    } else if (delimiterDepth === 0 && !continuesMemberChain(lines, i)) {
      out.push(layout(TokenType.Newline, lineNo, raw.length + 1));
    }
    if (delimiterDepth < 0) delimiterDepth = 0;
  }

  while (indents.length > 1) {
    indents.pop();
    out.push(layout(TokenType.Dedent, lastLine, 1));
  }
  out.push({ type: TokenType.EOF, value: "", line: lastLine + 1, column: 1 });
  return out;
}

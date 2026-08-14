import type { Position } from "./types.ts";

export type ImportToken = {
  text: string;
  line: number;
  start: number;
  end: number;
};

export type ImportSpecifierSyntax = {
  imported: ImportToken;
  local: ImportToken | null;
};

export type ImportSyntax = {
  form: "import" | "from";
  level: number;
  dots: ImportToken | null;
  path: ImportToken[];
  trailingDot: boolean;
  alias: ImportToken | null;
  importKeyword: ImportToken | null;
  specifiers: ImportSpecifierSyntax[];
  trailingComma: boolean;
  tokens: ImportToken[];
};

export type ImportCursor =
  | { kind: "path"; syntax: ImportSyntax; index: number; token: ImportToken }
  | { kind: "imported"; syntax: ImportSyntax; specifier: ImportSpecifierSyntax; token: ImportToken }
  | { kind: "local"; syntax: ImportSyntax; specifier: ImportSpecifierSyntax; token: ImportToken }
  | { kind: "alias"; syntax: ImportSyntax; token: ImportToken };

export type ImportCompletion =
  | { kind: "module"; syntax: ImportSyntax; level: number; prefix: string[]; typed: string }
  | { kind: "names"; syntax: ImportSyntax; typed: string };

const STATEMENT_LOOKBACK = 64;
const WORD = /[A-Za-z_$][\w$]*/y;
const KEYWORDS = new Set(["import", "from", "as"]);

export function importsIn(lines: readonly string[]): ImportSyntax[] {
  const statements: ImportSyntax[] = [];
  for (let line = 0; line < lines.length; line++) {
    const head = leadingWord(lines[line] ?? "");
    if (head !== "import" && head !== "from") continue;
    const end = statementEnd(lines, line);
    const syntax = parseImport(scan(lines, line, end));
    if (syntax !== null) statements.push(syntax);
    line = end;
  }
  return statements;
}

export function namespaceRequest(
  statements: readonly ImportSyntax[],
  local: string,
): { level: number; path: string[] } | null {
  for (const syntax of statements) {
    if (syntax.form !== "import" || syntax.path.length === 0) continue;
    if (syntax.alias !== null) {
      if (syntax.alias.text === local) return { level: 0, path: syntax.path.map((token) => token.text) };
      continue;
    }
    if (syntax.path[0]!.text === local) return { level: 0, path: [syntax.path[0]!.text] };
  }
  return null;
}

export function importSyntaxAt(lines: readonly string[], line: number): ImportSyntax | null {
  const start = statementStart(lines, line);
  if (start === null) return null;
  const end = statementEnd(lines, start);
  if (line > end) return null;
  return parseImport(scan(lines, start, end));
}

export function importCursorAt(lines: readonly string[], position: Position): ImportCursor | null {
  const syntax = importSyntaxAt(lines, position.line);
  if (syntax === null) return null;
  return cursorIn(syntax, position);
}

export function importCompletionAt(
  lines: readonly string[],
  position: Position,
): ImportCompletion | null {
  const syntax = importSyntaxAt(lines, position.line);
  if (syntax === null) return null;
  if (!afterToken(syntax.tokens[0]!, position)) return null;

  const naming = syntax.importKeyword !== null && afterToken(syntax.importKeyword, position);
  if (naming) return { kind: "names", syntax, typed: typedNameAt(syntax, position) };
  if (syntax.alias !== null && afterToken(syntax.alias, position)) return null;

  const segments = syntax.path.filter((token) => before(token, position));
  const typed = segments.length > 0 && contains(segments[segments.length - 1]!, position)
    ? segments.pop()!.text
    : "";
  return { kind: "module", syntax, level: syntax.level, prefix: segments.map((t) => t.text), typed };
}

function typedNameAt(syntax: ImportSyntax, position: Position): string {
  for (const specifier of syntax.specifiers) {
    if (contains(specifier.imported, position)) return specifier.imported.text;
    if (specifier.local !== null && contains(specifier.local, position)) return specifier.local.text;
  }
  return "";
}

function cursorIn(syntax: ImportSyntax, position: Position): ImportCursor | null {
  for (let index = 0; index < syntax.path.length; index++) {
    const token = syntax.path[index]!;
    if (contains(token, position)) return { kind: "path", syntax, index, token };
  }
  if (syntax.dots !== null && contains(syntax.dots, position)) {
    return { kind: "path", syntax, index: syntax.path.length - 1, token: syntax.dots };
  }
  if (syntax.alias !== null && contains(syntax.alias, position)) {
    return { kind: "alias", syntax, token: syntax.alias };
  }
  for (const specifier of syntax.specifiers) {
    if (contains(specifier.imported, position)) {
      return { kind: "imported", syntax, specifier, token: specifier.imported };
    }
    if (specifier.local !== null && contains(specifier.local, position)) {
      return { kind: "local", syntax, specifier, token: specifier.local };
    }
  }
  return null;
}

function contains(token: ImportToken, position: Position): boolean {
  return token.line === position.line
    && position.character >= token.start
    && position.character <= token.end;
}

function before(token: ImportToken, position: Position): boolean {
  if (token.line !== position.line) return token.line < position.line;
  return token.start <= position.character;
}

function afterToken(token: ImportToken, position: Position): boolean {
  if (token.line !== position.line) return token.line < position.line;
  return position.character >= token.end;
}

function statementStart(lines: readonly string[], line: number): number | null {
  for (let cursor = line; cursor >= 0 && line - cursor <= STATEMENT_LOOKBACK; cursor--) {
    const head = leadingWord(lines[cursor] ?? "");
    if (head === "import" || head === "from") return cursor;
  }
  return null;
}

function statementEnd(lines: readonly string[], start: number): number {
  let depth = 0;
  for (let cursor = start; cursor < lines.length; cursor++) {
    depth += parenDelta(lines[cursor] ?? "");
    if (depth <= 0) return cursor;
  }
  return lines.length - 1;
}

function parenDelta(line: string): number {
  let delta = 0;
  for (const token of scanLine(line, 0)) {
    if (token.text === "(") delta++;
    else if (token.text === ")") delta--;
  }
  return delta;
}

function leadingWord(line: string): string | null {
  const match = line.match(/^\s*([A-Za-z_$][\w$]*)/);
  return match ? match[1]! : null;
}

function scan(lines: readonly string[], start: number, end: number): ImportToken[] {
  const tokens: ImportToken[] = [];
  for (let line = start; line <= end; line++) tokens.push(...scanLine(lines[line] ?? "", line));
  return tokens;
}

function scanLine(text: string, line: number): ImportToken[] {
  const tokens: ImportToken[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "#" || (char === "/" && text[at + 1] === "/")) break;
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    WORD.lastIndex = at;
    const word = WORD.exec(text);
    if (word !== null) {
      tokens.push({ text: word[0], line, start: at, end: at + word[0].length });
      at += word[0].length;
      continue;
    }
    tokens.push({ text: char, line, start: at, end: at + 1 });
    at++;
  }
  return tokens;
}

function parseImport(tokens: ImportToken[]): ImportSyntax | null {
  const head = tokens[0];
  if (head === undefined) return null;
  if (head.text === "import") return parsePlainImport(tokens);
  if (head.text === "from") return parseFromImport(tokens);
  return null;
}

function parsePlainImport(tokens: ImportToken[]): ImportSyntax {
  const syntax: ImportSyntax = {
    form: "import",
    level: 0,
    dots: null,
    path: [],
    trailingDot: false,
    alias: null,
    importKeyword: null,
    specifiers: [],
    trailingComma: false,
    tokens,
  };
  let at = readPath(tokens, 1, syntax);
  if (tokens[at]?.text === "as") {
    at++;
    const alias = tokens[at];
    if (alias !== undefined && isName(alias)) syntax.alias = alias;
  }
  return syntax;
}

function parseFromImport(tokens: ImportToken[]): ImportSyntax {
  const syntax: ImportSyntax = {
    form: "from",
    level: 0,
    dots: null,
    path: [],
    trailingDot: false,
    alias: null,
    importKeyword: null,
    specifiers: [],
    trailingComma: false,
    tokens,
  };
  let at = 1;
  const dotStart = tokens[at];
  while (tokens[at]?.text === ".") {
    syntax.level++;
    at++;
  }
  if (syntax.level > 0 && dotStart !== undefined) {
    const last = tokens[at - 1]!;
    syntax.dots = { text: ".".repeat(syntax.level), line: dotStart.line, start: dotStart.start, end: last.end };
  }
  at = readPath(tokens, at, syntax);
  if (tokens[at]?.text !== "import") return syntax;
  syntax.importKeyword = tokens[at]!;
  at++;
  if (tokens[at]?.text === "(") at++;
  readSpecifiers(tokens, at, syntax);
  return syntax;
}

function readPath(tokens: ImportToken[], from: number, syntax: ImportSyntax): number {
  let at = from;
  for (;;) {
    const token = tokens[at];
    if (token === undefined || !isName(token)) break;
    syntax.path.push(token);
    syntax.trailingDot = false;
    at++;
    if (tokens[at]?.text !== ".") break;
    syntax.trailingDot = true;
    at++;
  }
  return at;
}

function readSpecifiers(tokens: ImportToken[], from: number, syntax: ImportSyntax): void {
  let at = from;
  for (;;) {
    const imported = tokens[at];
    if (imported === undefined || !isName(imported)) break;
    const specifier: ImportSpecifierSyntax = { imported, local: null };
    at++;
    if (tokens[at]?.text === "as") {
      at++;
      const local = tokens[at];
      if (local !== undefined && isName(local)) {
        specifier.local = local;
        at++;
      }
    }
    syntax.specifiers.push(specifier);
    if (tokens[at]?.text !== ",") {
      syntax.trailingComma = false;
      break;
    }
    syntax.trailingComma = true;
    at++;
  }
}

function isName(token: ImportToken): boolean {
  return /^[A-Za-z_$]/.test(token.text) && !KEYWORDS.has(token.text);
}

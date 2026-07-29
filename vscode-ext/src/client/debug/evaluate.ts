import type {
  DebugBindingSnapshot,
  DebugPropertySnapshot,
  DebugValueSnapshot,
} from "../../../../src/index.ts";

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: string }
  | { type: "punct"; value: string }
  | { type: "eof"; value: "" };

type Env = {
  locals: DebugBindingSnapshot[];
  globals: DebugBindingSnapshot[];
};

const OPERATORS = [
  "===",
  "!==",
  "&&",
  "||",
  "<=",
  ">=",
  "==",
  "!=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
];

function error(message: string): never {
  throw new Error(message);
}

function value(
  tag: string,
  display: string,
  raw?: string | number | boolean | null,
): DebugValueSnapshot {
  return raw === undefined ? { tag, display } : { tag, display, raw };
}

function numberValue(raw: number): DebugValueSnapshot {
  return value(Number.isInteger(raw) ? "smi" : "double", String(raw), raw);
}

function boolValue(raw: boolean): DebugValueSnapshot {
  return value("bool", String(raw), raw);
}

function stringValue(raw: string): DebugValueSnapshot {
  return value("string", raw, raw);
}

function nullValue(): DebugValueSnapshot {
  return value("null", "null", null);
}

function undefinedValue(): DebugValueSnapshot {
  return value("undefined", "undefined");
}

function rawPrimitive(valueSnapshot: DebugValueSnapshot): string | number | boolean | null | undefined {
  return valueSnapshot.raw;
}

function truthy(valueSnapshot: DebugValueSnapshot): boolean {
  const raw = rawPrimitive(valueSnapshot);
  if (raw !== undefined) return !!raw;
  return valueSnapshot.tag !== "undefined" && valueSnapshot.tag !== "null";
}

function numeric(valueSnapshot: DebugValueSnapshot): number {
  const raw = rawPrimitive(valueSnapshot);
  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string") return Number(raw);
  if (raw === null) return 0;
  return Number.NaN;
}

function equal(left: DebugValueSnapshot, right: DebugValueSnapshot, strict: boolean): boolean {
  const leftRaw = rawPrimitive(left);
  const rightRaw = rawPrimitive(right);
  return strict
    ? leftRaw === rightRaw && left.tag === right.tag
    : leftRaw == rightRaw;
}

function childByName(
  parent: DebugValueSnapshot,
  name: string,
): DebugPropertySnapshot | undefined {
  return parent.children?.find((child) => child.name === name);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index]!;
    if (/\s/.test(ch)) {
      index++;
      continue;
    }
    if (/\d/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[\d_]/.test(source[end]!)) end++;
      if (source[end] === ".") {
        end++;
        while (end < source.length && /[\d_]/.test(source[end]!)) end++;
      }
      tokens.push({
        type: "number",
        value: Number(source.slice(index, end).replace(/_/g, "")),
      });
      index = end;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      let end = index + 1;
      let out = "";
      while (end < source.length) {
        const current = source[end]!;
        if (current === quote) break;
        if (current === "\\") {
          const next = source[end + 1];
          if (next === undefined) error("Unterminated string literal");
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          end += 2;
        } else {
          out += current;
          end++;
        }
      }
      if (source[end] !== quote) error("Unterminated string literal");
      tokens.push({ type: "string", value: out });
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) end++;
      tokens.push({ type: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (op) {
      tokens.push({ type: "operator", value: op });
      index += op.length;
      continue;
    }
    if ("().[]".includes(ch)) {
      tokens.push({ type: "punct", value: ch });
      index++;
      continue;
    }
    error(`Unexpected token '${ch}'`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly env: Env,
  ) {}

  parse(): DebugValueSnapshot {
    const result = this.logicalOr();
    this.expect("eof");
    return result;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private advance(): Token {
    return this.tokens[this.index++]!;
  }

  private match(type: Token["type"], value?: string): boolean {
    const token = this.peek();
    if (token.type !== type) return false;
    if (value !== undefined && token.value !== value) return false;
    this.index++;
    return true;
  }

  private expect(type: Token["type"], value?: string): Token {
    const token = this.advance();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      error(value ? `Expected '${value}'` : `Expected ${type}`);
    }
    return token;
  }

  private logicalOr(): DebugValueSnapshot {
    let left = this.logicalAnd();
    while (this.match("operator", "||")) {
      const right = this.logicalAnd();
      left = boolValue(truthy(left) || truthy(right));
    }
    return left;
  }

  private logicalAnd(): DebugValueSnapshot {
    let left = this.equality();
    while (this.match("operator", "&&")) {
      const right = this.equality();
      left = boolValue(truthy(left) && truthy(right));
    }
    return left;
  }

  private equality(): DebugValueSnapshot {
    let left = this.comparison();
    while (this.peek().type === "operator" && ["==", "!=", "===", "!=="].includes(String(this.peek().value))) {
      const op = String(this.advance().value);
      const right = this.comparison();
      const result = op === "==" || op === "==="
        ? equal(left, right, op === "===")
        : !equal(left, right, op === "!==");
      left = boolValue(result);
    }
    return left;
  }

  private comparison(): DebugValueSnapshot {
    let left = this.term();
    while (this.peek().type === "operator" && ["<", "<=", ">", ">="].includes(String(this.peek().value))) {
      const op = String(this.advance().value);
      const right = this.term();
      const a = numeric(left);
      const b = numeric(right);
      left = boolValue(
        op === "<" ? a < b :
          op === "<=" ? a <= b :
            op === ">" ? a > b : a >= b,
      );
    }
    return left;
  }

  private term(): DebugValueSnapshot {
    let left = this.factor();
    while (this.peek().type === "operator" && ["+", "-"].includes(String(this.peek().value))) {
      const op = String(this.advance().value);
      const right = this.factor();
      const leftRaw = rawPrimitive(left);
      const rightRaw = rawPrimitive(right);
      if (op === "+" && (typeof leftRaw === "string" || typeof rightRaw === "string")) {
        left = stringValue(String(leftRaw ?? left.display) + String(rightRaw ?? right.display));
      } else {
        left = numberValue(op === "+" ? numeric(left) + numeric(right) : numeric(left) - numeric(right));
      }
    }
    return left;
  }

  private factor(): DebugValueSnapshot {
    let left = this.unary();
    while (this.peek().type === "operator" && ["*", "/", "%"].includes(String(this.peek().value))) {
      const op = String(this.advance().value);
      const right = this.unary();
      const a = numeric(left);
      const b = numeric(right);
      left = numberValue(op === "*" ? a * b : op === "/" ? a / b : a % b);
    }
    return left;
  }

  private unary(): DebugValueSnapshot {
    if (this.match("operator", "!")) return boolValue(!truthy(this.unary()));
    if (this.match("operator", "-")) return numberValue(-numeric(this.unary()));
    if (this.match("operator", "+")) return numberValue(+numeric(this.unary()));
    return this.postfix();
  }

  private postfix(): DebugValueSnapshot {
    let current = this.primary();
    while (true) {
      if (this.match("punct", ".")) {
        const name = String(this.expect("identifier").value);
        current = childByName(current, name)?.value ?? undefinedValue();
      } else if (this.match("punct", "[")) {
        const key = this.logicalOr();
        this.expect("punct", "]");
        current = childByName(current, String(rawPrimitive(key) ?? key.display))?.value ?? undefinedValue();
      } else if (this.match("punct", "(")) {
        error("Function calls in Watch are disabled");
      } else {
        return current;
      }
    }
  }

  private primary(): DebugValueSnapshot {
    const token = this.advance();
    if (token.type === "number") return numberValue(token.value);
    if (token.type === "string") return stringValue(token.value);
    if (token.type === "identifier") {
      if (token.value === "true") return boolValue(true);
      if (token.value === "false") return boolValue(false);
      if (token.value === "null") return nullValue();
      if (token.value === "undefined") return undefinedValue();
      const binding = this.env.locals.find((item) => item.name === token.value) ??
        this.env.globals.find((item) => item.name === token.value);
      if (!binding) error(`${token.value} is not available`);
      return binding.value;
    }
    if (token.type === "punct" && token.value === "(") {
      const result = this.logicalOr();
      this.expect("punct", ")");
      return result;
    }
    error("Expected expression");
  }
}

export function evaluateDebugExpression(
  expression: string,
  env: Env,
): DebugValueSnapshot {
  return new ExpressionParser(tokenize(expression), env).parse();
}

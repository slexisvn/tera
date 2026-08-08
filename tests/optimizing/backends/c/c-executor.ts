export function runCFunction(source: string, symbol: string, args: number[]): number {
  const fn = extractFunction(source, symbol);
  const env = new Map<string, number>();
  const params = parseParams(fn.params);
  if (params.length !== args.length) {
    throw new Error(`expected ${params.length} args, got ${args.length}`);
  }
  for (let i = 0; i < params.length; i++) env.set(params[i]!, args[i]!);

  const lines = fn.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const labels = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i]!.match(/^([A-Za-z_]\w*):;$/);
    if (label) labels.set(label[1]!, i);
  }

  let pc = 0;
  let steps = 0;
  const maxSteps = Math.max(lines.length * lines.length, lines.length + 1);
  while (pc < lines.length) {
    if (steps++ > maxSteps) throw new Error(`execution did not terminate in ${symbol}`);
    const line = lines[pc]!;
    if (/^[A-Za-z_]\w*:;$/.test(line) || line === "}" || line === "} else {") {
      pc++;
      continue;
    }
    if (/^\(void\)[A-Za-z_]\w*;$/.test(line)) {
      pc++;
      continue;
    }

    const declaration = line.match(/^double\s+([A-Za-z_]\w*);$/);
    if (declaration) {
      env.set(declaration[1]!, 0);
      pc++;
      continue;
    }

    const constAssignment = line.match(/^const double\s+([A-Za-z_]\w*)\s*=\s*(.+);$/);
    if (constAssignment) {
      env.set(constAssignment[1]!, evalExpr(constAssignment[2]!, env));
      pc++;
      continue;
    }

    const assignment = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+);$/);
    if (assignment) {
      env.set(assignment[1]!, evalExpr(assignment[2]!, env));
      pc++;
      continue;
    }

    const branch = line.match(/^if \((.+) != 0\.0\) \{$/);
    if (branch) {
      const trueLabel = parseGoto(lines[pc + 1]);
      const falseLabel = parseGoto(lines[pc + 3]);
      pc = jumpTo(labels, evalExpr(branch[1]!, env) !== 0 ? trueLabel : falseLabel);
      continue;
    }

    const gotoLabel = parseGoto(line);
    if (gotoLabel !== null) {
      pc = jumpTo(labels, gotoLabel);
      continue;
    }

    const ret = line.match(/^return\s+(.+);$/);
    if (ret) return evalExpr(ret[1]!, env);

    throw new Error(`unsupported C line: ${line}`);
  }
  throw new Error(`function ${symbol} fell through`);
}

function extractFunction(
  source: string,
  symbol: string,
): { readonly params: string; readonly body: string } {
  const match = new RegExp(`double\\s+${escapeRegExp(symbol)}\\s*\\(([^)]*)\\)\\s*\\{`).exec(
    source,
  );
  if (!match) throw new Error(`missing function ${symbol}`);
  const bodyStart = match.index + match[0].length;
  let depth = 1;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return { params: match[1]!, body: source.slice(bodyStart, i) };
  }
  throw new Error(`unterminated function ${symbol}`);
}

function parseParams(params: string): string[] {
  const trimmed = params.trim();
  if (trimmed.length === 0 || trimmed === "void") return [];
  return trimmed.split(",").map((param) => {
    const match = param.trim().match(/^double\s+([A-Za-z_]\w*)$/);
    if (!match) throw new Error(`unsupported parameter: ${param}`);
    return match[1]!;
  });
}

function parseGoto(line: string | undefined): string | null {
  const match = line?.match(/^goto\s+([A-Za-z_]\w*);$/);
  return match ? match[1]! : null;
}

function jumpTo(labels: ReadonlyMap<string, number>, label: string | null): number {
  if (label === null) throw new Error("missing goto target");
  const pc = labels.get(label);
  if (pc === undefined) throw new Error(`unknown label ${label}`);
  return pc;
}

function evalExpr(expr: string, env: ReadonlyMap<string, number>): number {
  const intExpr = expr.match(
    /^tera_i32_to_double\(\(uint32_t\)\(int32_t\)([A-Za-z_]\w*)\s*([+\-*])\s*\(uint32_t\)\(int32_t\)([A-Za-z_]\w*)\)$/,
  );
  if (intExpr) {
    const left = toUint32(valueOf(intExpr[1]!, env));
    const right = toUint32(valueOf(intExpr[3]!, env));
    if (intExpr[2] === "+") return fromUint32((left + right) >>> 0);
    if (intExpr[2] === "-") return fromUint32((left - right) >>> 0);
    return fromUint32(Math.imul(left, right) >>> 0);
  }

  const compare = expr.match(/^\((.+)\s+(<=|>=|==|!=|<|>)\s+(.+)\)\s*\?\s*1\.0\s*:\s*0\.0$/);
  if (compare) {
    const left = valueOf(stripParens(compare[1]!), env);
    const right = valueOf(stripParens(compare[3]!), env);
    return compareValues(left, right, compare[2]!) ? 1 : 0;
  }

  const binary = expr.match(/^([A-Za-z_]\w*)\s+([+\-*/])\s+([A-Za-z_]\w*)$/);
  if (binary) {
    const left = valueOf(binary[1]!, env);
    const right = valueOf(binary[3]!, env);
    if (binary[2] === "+") return left + right;
    if (binary[2] === "-") return left - right;
    if (binary[2] === "*") return left * right;
    return left / right;
  }

  if (/^-[A-Za-z_]\w*$/.test(expr)) return -valueOf(expr.slice(1), env);
  return valueOf(expr, env);
}

function valueOf(term: string, env: ReadonlyMap<string, number>): number {
  let text = term.trim();
  let intCast = false;
  while (text.startsWith("(int32_t)")) {
    intCast = true;
    text = text.slice("(int32_t)".length).trim();
  }
  const value = env.has(text) ? env.get(text)! : Number(text);
  if (Number.isNaN(value)) throw new Error(`unknown value ${term}`);
  return intCast ? toInt32(value) : value;
}

function compareValues(left: number, right: number, op: string): boolean {
  if (op === "<=") return left <= right;
  if (op === ">=") return left >= right;
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;
  if (op === "<") return left < right;
  return left > right;
}

function toInt32(value: number): number {
  return value | 0;
}

function toUint32(value: number): number {
  return toInt32(value) >>> 0;
}

function fromUint32(value: number): number {
  return value | 0;
}

function stripParens(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("(") && trimmed.endsWith(")")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

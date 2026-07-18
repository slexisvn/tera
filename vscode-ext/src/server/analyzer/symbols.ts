import type { BuiltinEnv } from "./builtin-env.ts";
import type { Position, Scope, ScopeKind, SymbolKind, SymbolTable, TeraSymbol } from "./types.ts";

const IDENT = "[A-Za-z_$][\\w$]*";

const PATTERNS = {
  fn: new RegExp(`^(?:async\\s+)?fn\\*?\\s+(${IDENT})\\s*\\(([^)]*)\\)`),
  model: new RegExp(`^model\\s+(${IDENT})\\s*\\(([^)]*)\\)`),
  class: new RegExp(`^class\\s+(${IDENT})`),
  method: new RegExp(`^(${IDENT})\\s*\\(([^)]*)\\)\\s*(?:->\\s*[^:]+)?\\s*:`),
  variable: new RegExp(`^(${IDENT})\\s*(?::\\s*([^=]+))?\\s*=\\s*(.+)$`),
  field: new RegExp(`^this\\.(${IDENT})\\s*(?::\\s*([^=]+))?\\s*=\\s*(.+)$`),
  param: new RegExp(`^(${IDENT})(?:\\s*:\\s*([^=]+?))?(?:\\s*=.*)?$`),
  returnType: /->\s*([^:]+):/,
  call: new RegExp(`^(${IDENT})\\s*\\(`),
  indent: /^ */,
};

type ParsedParam = { name: string; typeName: string | null; column: number };

type Declaration = {
  name: string;
  params: string | null;
  symbolKind: SymbolKind;
  scopeKind: ScopeKind;
  holdsFields: boolean;
};

export function buildSymbolTable(lines: string[], env: BuiltinEnv): SymbolTable {
  const root = makeScope("<root>", null, 1, lines.length + 1, 0);
  const scopes: Scope[] = [root];
  const stack: Scope[] = [root];
  const fieldsByType = new Map<string, TeraSymbol[]>();
  const declaredTypes = collectDeclaredTypes(lines);

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (!raw.trim()) continue;

    const indent = raw.match(PATTERNS.indent)![0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack[stack.length - 1].endLine = index + 1;
      stack.pop();
    }

    const scope = stack[stack.length - 1];
    const line = raw.trim();
    const column = raw.length - raw.trimStart().length;
    const lineNo = index + 1;

    const declaration = readDeclaration(line, stack);
    if (declaration) {
      const symbol = addSymbol(scope, declaration.name, declaration.symbolKind, lineNo, column + 1, readReturnType(line));
      const next = makeScope(declaration.name, scope, lineNo, lines.length + 1, indent, declaration.scopeKind);
      scopes.push(next);
      scope.children.push(next);
      stack.push(next);
      symbol.scope = next;

      if (declaration.holdsFields) fieldsByType.set(declaration.name, []);
      if (declaration.params) {
        const base = raw.indexOf("(") + 2;
        for (const param of parseParams(declaration.params)) {
          addSymbol(next, param.name, "parameter", lineNo, base + param.column - 1, param.typeName);
        }
        if (declaration.holdsFields) {
          const fields = fieldsByType.get(declaration.name)!;
          for (const param of parseParams(declaration.params)) {
            fields.push({ name: param.name, kind: "field", line: lineNo, column: param.column, typeName: param.typeName });
          }
        }
      }
      continue;
    }

    const field = line.match(PATTERNS.field);
    if (field) {
      const owner = enclosingType(stack);
      if (owner) {
        fieldsByType.get(owner)?.push({
          name: field[1],
          kind: "field",
          line: lineNo,
          column: column + 6,
          typeName: cleanType(field[2]) ?? inferType(field[3], env, declaredTypes),
        });
      }
      continue;
    }

    const variable = line.match(PATTERNS.variable);
    if (variable) {
      addSymbol(scope, variable[1], "variable", lineNo, column + 1, cleanType(variable[2]) ?? inferType(variable[3], env, declaredTypes));
    }
  }

  while (stack.length > 1) {
    stack[stack.length - 1].endLine = lines.length + 1;
    stack.pop();
  }

  return {
    root,
    scopes,
    flat: scopes.flatMap((scope) => scope.symbols),
    findScopeAt: (position) => findScopeAt(root, position.line + 1),
    resolve: (name, position) => resolveName(root, name, position.line + 1),
    resolveField: (typeName, fieldName) =>
      (typeName ? fieldsByType.get(typeName)?.find((f) => f.name === fieldName) : null) ?? null,
  };
}

function readDeclaration(line: string, stack: Scope[]): Declaration | null {
  const fn = line.match(PATTERNS.fn);
  if (fn) return { name: fn[1], params: fn[2], symbolKind: "function", scopeKind: "function", holdsFields: false };

  const model = line.match(PATTERNS.model);
  if (model) return { name: model[1], params: model[2], symbolKind: "model", scopeKind: "model", holdsFields: true };

  const cls = line.match(PATTERNS.class);
  if (cls) return { name: cls[1], params: null, symbolKind: "module", scopeKind: "class", holdsFields: true };

  const insideType = stack.some((scope) => scope.kind === "class" || scope.kind === "model");
  if (!insideType) return null;

  const method = line.match(PATTERNS.method);
  if (!method) return null;
  return { name: method[1], params: method[2], symbolKind: "function", scopeKind: "function", holdsFields: false };
}

function makeScope(
  name: string,
  parent: Scope | null,
  startLine: number,
  endLine: number,
  indent: number,
  kind: ScopeKind = "scope",
): Scope {
  return { name, kind, parent, children: [], symbols: [], startLine, endLine, indent };
}

function addSymbol(
  scope: Scope,
  name: string,
  kind: SymbolKind,
  line: number,
  column: number,
  typeName: string | null = null,
): TeraSymbol {
  const symbol: TeraSymbol = { name, kind, line, column, typeName };
  scope.symbols.push(symbol);
  return symbol;
}

function parseParams(params: string): ParsedParam[] {
  const out: ParsedParam[] = [];
  let offset = 0;
  for (const raw of params.split(",")) {
    const match = raw.trim().match(PATTERNS.param);
    if (match) {
      out.push({
        name: match[1],
        typeName: cleanType(match[2]),
        column: offset + raw.indexOf(match[1]) + 1,
      });
    }
    offset += raw.length + 1;
  }
  return out;
}

function cleanType(type: string | undefined): string | null {
  return type?.trim() || null;
}

function readReturnType(line: string): string | null {
  return cleanType(line.match(PATTERNS.returnType)?.[1]);
}

function collectDeclaredTypes(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(PATTERNS.model) ?? line.match(PATTERNS.class);
    if (match) out.add(match[1]);
  }
  return out;
}

function inferType(value: string | undefined, env: BuiltinEnv, declaredTypes: Set<string>): string | null {
  const callee = value?.trim().match(PATTERNS.call)?.[1];
  if (!callee) return null;
  if (declaredTypes.has(callee)) return callee;
  if (!env.builtinNames.has(callee)) return null;
  return env.builtinTypes.get(callee) ?? callee;
}

function enclosingType(stack: Scope[]): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === "class" || stack[i].kind === "model") return stack[i].name;
  }
  return null;
}

function findScopeAt(scope: Scope, line: number): Scope {
  for (const child of scope.children) {
    if (line >= child.startLine && line <= child.endLine) return findScopeAt(child, line);
  }
  return scope;
}

function resolveName(root: Scope, name: string, line: number): TeraSymbol | null {
  let scope: Scope | null = findScopeAt(root, line);
  while (scope) {
    const found = [...scope.symbols].reverse().find((s) => s.name === name && s.line <= line);
    if (found) return found;
    scope = scope.parent;
  }
  return null;
}

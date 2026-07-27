import type { BuiltinEnv } from "./builtin-env.ts";
import type { Position, Scope, ScopeKind, SymbolKind, SymbolTable, TeraSymbol } from "./types.ts";

const IDENT = "[A-Za-z_$][\\w$]*";

const PATTERNS = {
  fn: new RegExp(`^(?:async\\s+)?fn\\*?\\s+(${IDENT})\\s*\\(([^)]*)\\)`),
  model: new RegExp(`^model\\s+(${IDENT})\\s*\\(([^)]*)\\)`),
  class: new RegExp(`^class\\s+(${IDENT})(?:\\s+extends\\s+(${IDENT}))?`),
  interface: new RegExp(`^interface\\s+(${IDENT})(?:\\s+extends\\s+(${IDENT}))?`),
  interfaceField: new RegExp(`^(${IDENT})\\??\\s*:\\s*(.+)$`),
  typeAlias: new RegExp(`^type\\s+(${IDENT})`),
  accessor: new RegExp(`^(get|set)\\s+(${IDENT})\\s*\\(([^)]*)\\)`),
  method: new RegExp(`^(${IDENT})\\s*\\(([^)]*)\\)\\s*(?:->\\s*[^:]+)?\\s*:`),
  blockMethod: new RegExp(`^(${IDENT})\\s*:\\s*$`),
  forEach: new RegExp(`^for\\s+(${IDENT})\\s+(of|in)\\s+(.+):\\s*$`),
  comprehensionVar: new RegExp(`\\bfor\\s+(${IDENT})\\s+(?:of|in)\\b`, "g"),
  arrowParam: new RegExp(`(?:^|[^.\\w$])(${IDENT})\\s*=>`, "g"),
  arrowParams: new RegExp(`\\(([^)]*)\\)\\s*=>`, "g"),
  destructuredVariable: new RegExp(`^(${IDENT}(?:\\s*,\\s*${IDENT})+)\\s*=\\s*(.+)$`),
  variable: new RegExp(`^(${IDENT})\\s*(?::\\s*([^=]+))?\\s*=\\s*(.+)$`),
  field: new RegExp(`^this\\.(${IDENT})\\s*(?::\\s*([^=]+))?\\s*=\\s*(.+)$`),
  param: new RegExp(`^(${IDENT})(?:\\s*:\\s*([^=]+?))?(?:\\s*=.*)?$`),
  paramName: new RegExp(`^(${IDENT})`),
  returnType: /->\s*([^:]+):/,
  indent: /^ */,
};

type ParsedParam = { name: string; typeName: string | null; column: number };

type Declaration = {
  name: string;
  params: string | null;
  symbolKind: SymbolKind;
  scopeKind: ScopeKind;
  holdsFields: boolean;
  parent?: string;
  accessor?: "get" | "set";
};

export function buildSymbolTable(lines: string[], env: BuiltinEnv, inferredTypes: Map<string, string>, memberTypes: Map<string, string> = new Map()): SymbolTable {
  const root = makeScope("<root>", null, 1, lines.length + 1, 0);
  const scopes: Scope[] = [root];
  const stack: Scope[] = [root];
  const fieldsByType = new Map<string, TeraSymbol[]>();

  const inferredType = (name: string, line: number): string | null => {
    const type = inferredTypes.get(`${name}:${line}`);
    return type && type !== "any" ? type : null;
  };

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

    const declaration = readDeclaration(line, stack, env.keywords);
    if (declaration) {
      const symbol = addSymbol(scope, declaration.name, declaration.symbolKind, lineNo, column + 1, readReturnType(line));
      const next = makeScope(declaration.name, scope, lineNo, lines.length + 1, indent, declaration.scopeKind);
      scopes.push(next);
      scope.children.push(next);
      stack.push(next);
      symbol.scope = next;

      if (declaration.holdsFields) {
        const inherited = declaration.parent ? fieldsByType.get(declaration.parent) ?? [] : [];
        fieldsByType.set(declaration.name, inherited.map((member) => ({ ...member })));
      }
      if (declaration.params) {
        const base = raw.indexOf("(") + 2;
        for (const param of parseParams(declaration.params)) {
          addSymbol(next, param.name, "parameter", lineNo, base + param.column - 1, param.typeName);
        }
      }
      if ((scope.kind === "class" || scope.kind === "model") && declaration.name !== "constructor" && (declaration.symbolKind === "method" || declaration.symbolKind === "property")) {
        upsertMember(fieldsByType.get(scope.name), {
          name: declaration.name,
          kind: declaration.symbolKind,
          line: lineNo,
          column: column + (declaration.accessor ? line.indexOf(declaration.name) : 0) + 1,
          typeName: memberTypeName(declaration, line),
        });
      }
      continue;
    }

    const field = line.match(PATTERNS.field);
    if (field) {
      const owner = enclosingType(stack);
      if (owner) {
        upsertMember(fieldsByType.get(owner), {
          name: field[1],
          kind: "field",
          line: lineNo,
          column: column + 6,
          typeName: cleanType(field[2]) ?? inferredType(field[1], lineNo),
        });
      }
      continue;
    }

    if (scope.kind === "interface") {
      const ifaceField = line.match(PATTERNS.interfaceField);
      if (ifaceField) {
        upsertMember(fieldsByType.get(scope.name), {
          name: ifaceField[1],
          kind: "field",
          line: lineNo,
          column: column + 1,
          typeName: cleanType(ifaceField[2]),
        });
        continue;
      }
    }

    const loop = line.match(PATTERNS.forEach);
    if (loop) {
      addSymbol(scope, loop[1], "variable", lineNo, column + line.indexOf(loop[1]) + 1, inferredType(loop[1], lineNo));
      continue;
    }

    const destructured = line.match(PATTERNS.destructuredVariable);
    if (destructured) {
      for (const name of destructured[1].split(",").map((part) => part.trim())) {
        addSymbol(scope, name, "variable", lineNo, column + line.indexOf(name) + 1, inferredType(name, lineNo));
      }
      continue;
    }

    const variable = line.match(PATTERNS.variable);
    if (variable) {
      const typeName = cleanType(variable[2]) ?? inferredType(variable[1], lineNo);
      addSymbol(scope, variable[1], "variable", lineNo, column + 1, typeName);
      if (scope.kind === "model" || scope.kind === "class") {
        upsertMember(fieldsByType.get(scope.name), {
          name: variable[1],
          kind: "field",
          line: lineNo,
          column: column + 1,
          typeName,
        });
      }
    }

    for (const match of raw.matchAll(PATTERNS.comprehensionVar)) {
      const name = match[1];
      if (scope.symbols.some((symbol) => symbol.name === name && symbol.line === lineNo)) continue;
      addSymbol(scope, name, "variable", lineNo, (match.index ?? 0) + match[0].indexOf(name) + 1, inferredType(name, lineNo));
    }

    for (const match of raw.matchAll(PATTERNS.arrowParams)) {
      let offset = (match.index ?? 0) + match[0].indexOf("(") + 1;
      for (const piece of match[1].split(",")) {
        const name = piece.trim().match(PATTERNS.paramName);
        if (name) addParam(scope, name[1], lineNo, offset + piece.indexOf(name[1]) + 1, inferredType(name[1], lineNo));
        offset += piece.length + 1;
      }
    }
    for (const match of raw.matchAll(PATTERNS.arrowParam)) {
      addParam(scope, match[1], lineNo, (match.index ?? 0) + match[0].indexOf(match[1]) + 1, inferredType(match[1], lineNo));
    }
  }

  while (stack.length > 1) {
    stack[stack.length - 1].endLine = lines.length + 1;
    stack.pop();
  }

  for (const [key, type] of memberTypes) {
    const dot = key.indexOf(".");
    if (dot < 0) continue;
    const owner = key.slice(0, dot);
    const name = key.slice(dot + 1);
    const members = fieldsByType.get(owner) ?? [];
    if (!fieldsByType.has(owner)) fieldsByType.set(owner, members);
    const existing = members.find((member) => member.name === name);
    if (existing) existing.typeName = type;
    else members.push({ name, kind: type.includes("->") ? "method" : "field", line: 0, column: 0, typeName: type });
  }

  return {
    root,
    scopes,
    flat: scopes.flatMap((scope) => scope.symbols),
    findScopeAt: (position) => findScopeAt(root, position.line + 1),
    resolve: (name, position) => resolveName(root, name, position.line + 1, position.character + 1),
    resolveField: (typeName, fieldName) =>
      (typeName ? membersFor(typeName, fieldsByType).find((f) => f.name === fieldName) : null) ?? null,
    membersOf: (typeName) => (typeName ? membersFor(typeName, fieldsByType) : []),
  };
}

function readDeclaration(line: string, stack: Scope[], keywords: Set<string>): Declaration | null {
  const fn = line.match(PATTERNS.fn);
  if (fn) return { name: fn[1], params: fn[2], symbolKind: "function", scopeKind: "function", holdsFields: false };

  const model = line.match(PATTERNS.model);
  if (model) return { name: model[1], params: model[2], symbolKind: "model", scopeKind: "model", holdsFields: true };

  const cls = line.match(PATTERNS.class);
  if (cls) return { name: cls[1], params: null, symbolKind: "module", scopeKind: "class", holdsFields: true, parent: cls[2] };

  const iface = line.match(PATTERNS.interface);
  if (iface) return { name: iface[1], params: null, symbolKind: "module", scopeKind: "interface", holdsFields: true, parent: iface[2] };

  const alias = line.match(PATTERNS.typeAlias);
  if (alias) return { name: alias[1], params: null, symbolKind: "module", scopeKind: "scope", holdsFields: false };

  const insideType = stack.some((scope) => scope.kind === "class" || scope.kind === "model");
  if (!insideType) return null;

  const accessor = line.match(PATTERNS.accessor);
  if (accessor) {
    const kind = accessor[1] as "get" | "set";
    return { name: accessor[2], params: accessor[3], symbolKind: kind === "get" ? "property" : "method", scopeKind: "function", holdsFields: false, accessor: kind };
  }

  const method = line.match(PATTERNS.method);
  if (method) return { name: method[1], params: method[2], symbolKind: "method", scopeKind: "function", holdsFields: false };

  const block = line.match(PATTERNS.blockMethod);
  if (block && !keywords.has(block[1])) return { name: block[1], params: null, symbolKind: "method", scopeKind: "function", holdsFields: false };

  return null;
}

function memberTypeName(declaration: Declaration, line: string): string | null {
  const returnType = readReturnType(line);
  if (declaration.accessor === "get") return returnType;
  if (declaration.accessor === "set") return parseParams(declaration.params ?? "")[0]?.typeName ?? null;
  const params = parseParams(declaration.params ?? "").map((param) => param.typeName ?? "any").join(", ");
  return `(${params}) -> ${returnType ?? "any"}`;
}

function upsertMember(members: TeraSymbol[] | undefined, member: TeraSymbol): void {
  if (!members) return;
  const existing = members.findIndex((entry) => entry.name === member.name);
  if (existing >= 0) members[existing] = member;
  else members.push(member);
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

function addParam(scope: Scope, name: string, line: number, column: number, typeName: string | null): void {
  if (scope.symbols.some((symbol) => symbol.name === name && symbol.line === line && symbol.column === column)) return;
  addSymbol(scope, name, "parameter", line, column, typeName);
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

function membersFor(typeName: string, fieldsByType: Map<string, TeraSymbol[]>): TeraSymbol[] {
  const type = typeName.trim();
  return objectTypeMembers(type) ?? fieldsByType.get(type) ?? [];
}

function objectTypeMembers(typeName: string): TeraSymbol[] | null {
  const type = typeName.trim();
  if (!type.startsWith("{") || !type.endsWith("}")) return null;
  const out: TeraSymbol[] = [];
  for (const part of splitTopLevel(type.slice(1, -1))) {
    const match = part.trim().match(/^([A-Za-z_$][\w$]*)\??\s*:\s*(.+)$/);
    if (match) out.push({ name: match[1], kind: "field", line: 0, column: 0, typeName: match[2].trim() });
  }
  return out;
}

function splitTopLevel(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
    else if (ch === "," && depth === 0) { out.push(source.slice(start, i)); start = i + 1; }
  }
  out.push(source.slice(start));
  return out;
}

function enclosingType(stack: Scope[]): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === "class" || stack[i].kind === "model" || stack[i].kind === "interface") return stack[i].name;
  }
  return null;
}

function findScopeAt(scope: Scope, line: number): Scope {
  for (const child of scope.children) {
    if (line >= child.startLine && line <= child.endLine) return findScopeAt(child, line);
  }
  return scope;
}

function resolveName(root: Scope, name: string, line: number, column: number): TeraSymbol | null {
  let scope: Scope | null = findScopeAt(root, line);
  while (scope) {
    let best: TeraSymbol | null = null;
    for (const symbol of scope.symbols) {
      if (symbol.name !== name || symbol.line > line) continue;
      if (symbol.line === line && symbol.column > column) continue;
      if (!best || symbol.line > best.line || (symbol.line === best.line && symbol.column > best.column)) best = symbol;
    }
    if (best) return best;
    scope = scope.parent;
  }
  return null;
}

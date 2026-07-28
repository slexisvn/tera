import { NodeType, type ASTNode } from "../ast/index.js";
import { TERA_PSEUDO_TYPES } from "../../../data/tera-language-spec.js";
import { parseSemanticProgram } from "./semantic-parser.js";
import type { ClassMemberNode, FunctionNode, SemanticNode } from "./semantic-ast.js";
import { builtinMethod, createTypeEnv, signatureType, type Binding } from "./type-system.js";

export type SymbolPosition = { line: number; character: number };

export type SymbolKind = "function" | "model" | "module" | "variable" | "parameter" | "field" | "method" | "property";

export type ScopeKind = "scope" | "function" | "class" | "model" | "interface";

export type SourceSymbol = {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  typeName: string | null;
  visibleFromLine?: number;
  visibleFromColumn?: number;
  scope?: SourceScope;
};

export type SourceScope = {
  name: string;
  kind: ScopeKind;
  parent: SourceScope | null;
  children: SourceScope[];
  symbols: SourceSymbol[];
  startLine: number;
  endLine: number;
  indent: number;
};

export type SourceSymbolTable = {
  root: SourceScope;
  scopes: SourceScope[];
  flat: SourceSymbol[];
  findScopeAt(position: SymbolPosition): SourceScope;
  resolve(name: string, position: SymbolPosition): SourceSymbol | null;
  resolveField(typeName: string | null, fieldName: string): SourceSymbol | null;
  membersOf(typeName: string | null): SourceSymbol[];
};

export function buildSourceSymbolTable(source: string, inferredSymbols: Iterable<InferredSymbolInput> = []): SourceSymbolTable {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const inferred = collectInferredTypes(inferredSymbols);
  const builder = new SymbolTableBuilder(lines, inferred);
  try {
    builder.visitProgram(parseSemanticProgram(source).body);
  } catch {
    return builder.finish();
  }
  builder.materializeInferredLocals();
  return builder.finish();
}

type InferredTypes = {
  locals: Map<string, InferredLocal[]>;
  members: Map<string, string>;
};

type InferredLocal = {
  name: string;
  line: number;
  column: number;
  type: string;
  kind?: SymbolKind;
  scopeStartLine?: number;
  scopeStartColumn?: number;
};

type InferredSymbolInput = {
  name: string;
  line: number;
  column: number;
  type: string;
  kind?: SymbolKind;
  scopeStartLine?: number;
  scopeStartColumn?: number;
};

class SymbolTableBuilder {
  root: SourceScope;
  scopes: SourceScope[];
  fieldsByType = builtinFieldsByType();

  constructor(private readonly lines: string[], private readonly inferred: InferredTypes) {
    this.root = makeScope("<root>", null, 1, lines.length + 1, 0);
    this.scopes = [this.root];
  }

  visitProgram(nodes: SemanticNode[]): void {
    for (const node of nodes) this.visitNode(node, this.root);
  }

  materializeInferredLocals(): void {
    for (const locals of this.inferred.locals.values()) {
      for (const local of locals) {
        const scope = findScopeAt(this.root, local.line);
        if (scope.symbols.some((symbol) => symbol.name === local.name && symbol.line === local.line && symbol.column === local.column)) continue;
        addSymbol(scope, local.name, local.kind ?? "variable", local.line, local.column, local.type === "any" ? null : local.type, {
          visibleFromLine: local.scopeStartLine,
          visibleFromColumn: local.scopeStartColumn,
        });
      }
    }
  }

  finish(): SourceSymbolTable {
    for (const [key, type] of this.inferred.members) {
      const dot = key.indexOf(".");
      if (dot < 0) continue;
      const owner = key.slice(0, dot);
      const name = key.slice(dot + 1);
      const members = this.fieldsByType.get(owner) ?? [];
      if (!this.fieldsByType.has(owner)) this.fieldsByType.set(owner, members);
      upsertInferredMember(members, { name, kind: type.includes("->") ? "method" : "field", line: 0, column: 0, typeName: type });
    }

    const root = this.root;
    const fieldsByType = this.fieldsByType;
    return {
      root,
      scopes: this.scopes,
      flat: this.scopes.flatMap((scope) => scope.symbols),
      findScopeAt: (position) => findScopeAt(root, position.line + 1),
      resolve: (name, position) => resolveName(root, name, position.line + 1, position.character + 1),
      resolveField: (typeName, fieldName) =>
        (typeName ? membersFor(typeName, fieldsByType).find((field) => field.name === fieldName) : null) ?? null,
      membersOf: (typeName) => typeName ? membersFor(typeName, fieldsByType) : [],
    };
  }

  private visitNode(node: SemanticNode, scope: SourceScope): void {
    switch (node.kind) {
      case "Function":
        this.visitFunction(node, scope);
        break;
      case "Model":
        this.visitModel(node, scope);
        break;
      case "Class":
        this.visitClass(node, scope);
        break;
      case "Interface":
        this.visitInterface(node, scope);
        break;
      case "TypeAlias":
        addSymbol(scope, node.name, "module", node.nameSpan.line, node.nameSpan.column, node.type);
        break;
      case "Block":
        this.visitBlock(node.body, scope, "scope", node.span.line, node.span.column);
        break;
      case "For":
        this.visitFor(node, scope);
        break;
      case "Var":
        this.visitVar(node, scope);
        break;
      case "Destructure":
        for (const [index, name] of node.names.entries()) {
          const at = node.variableSpans[index] ?? node.span;
          addSymbol(scope, name, "variable", at.line, at.column, this.localType(name, at.line));
        }
        break;
      case "Expr":
        this.visitExpression(node.value, scope, node.span);
        break;
      case "Return":
        break;
    }
  }

  private visitFunction(node: FunctionNode, scope: SourceScope): SourceScope {
    const symbol = addSymbol(scope, node.name, "function", node.nameSpan.line, node.nameSpan.column, returnType(node.returns));
    const child = this.childScope(scope, node.name, "function", node.span.line, node.span.column);
    symbol.scope = child;
    this.addParams(child, node);
    for (const stmt of node.body) this.visitNode(stmt, child);
    child.endLine = endLine(node.body, node.span.line);
    return child;
  }

  private visitModel(node: Extract<SemanticNode, { kind: "Model" }>, scope: SourceScope): void {
    const symbol = addSymbol(scope, node.name, "model", node.nameSpan.line, node.nameSpan.column);
    const child = this.childScope(scope, node.name, "model", node.span.line, node.span.column);
    symbol.scope = child;
    this.fieldsByType.set(node.name, []);
    for (const param of node.params) addSymbol(child, param.name, "parameter", param.span.line, param.span.column, cleanType(param.type));
    for (const stmt of node.body) this.visitNode(stmt, child);
    child.endLine = endLine(node.body, node.span.line);
  }

  private visitClass(node: Extract<SemanticNode, { kind: "Class" }>, scope: SourceScope): void {
    const staticType = `typeof ${node.name}`;
    const symbol = addSymbol(scope, node.name, "module", node.nameSpan.line, node.nameSpan.column, staticType);
    const child = this.childScope(scope, node.name, "class", node.span.line, node.span.column);
    symbol.scope = child;
    this.fieldsByType.set(node.name, inheritedMembers(this.fieldsByType, node.parent));
    this.fieldsByType.set(staticType, inheritedMembers(this.fieldsByType, node.parent ? `typeof ${node.parent}` : undefined));
    for (const member of node.members) this.visitClassMember(member, child, node.name);
    child.endLine = endLine(node.members.map((member) => member.fn), node.span.line);
  }

  private visitInterface(node: Extract<SemanticNode, { kind: "Interface" }>, scope: SourceScope): void {
    const symbol = addSymbol(scope, node.name, "module", node.nameSpan.line, node.nameSpan.column);
    const child = this.childScope(scope, node.name, "interface", node.span.line, node.span.column);
    symbol.scope = child;
    const members = inheritedMembers(this.fieldsByType, node.parents[0]);
    this.fieldsByType.set(node.name, members);
    for (const field of node.fields) {
      const member = addSymbol(child, field.name, "field", field.span.line, field.span.column, cleanType(field.type));
      upsertMember(members, member);
    }
  }

  private visitBlock(body: SemanticNode[], scope: SourceScope, kind: ScopeKind, line: number, column: number): void {
    const child = this.childScope(scope, scope.name, kind, line, column);
    for (const stmt of body) this.visitNode(stmt, child);
    child.endLine = endLine(body, line);
  }

  private visitFor(node: Extract<SemanticNode, { kind: "For" }>, scope: SourceScope): void {
    const child = this.childScope(scope, scope.name, "scope", node.span.line, node.span.column);
    addSymbol(child, node.variable, "variable", node.variableSpan.line, node.variableSpan.column, this.localType(node.variable, node.variableSpan.line));
    for (const stmt of node.body) this.visitNode(stmt, child);
    child.endLine = endLine(node.body, node.span.line);
  }

  private visitVar(node: Extract<SemanticNode, { kind: "Var" }>, scope: SourceScope): void {
    const typeName = cleanType(node.declaredType) ?? this.localType(node.name, node.span.line);
    const symbol = addSymbol(scope, node.name, "variable", node.nameSpan.line, node.nameSpan.column, typeName);
    if (scope.kind === "model" || scope.kind === "class") upsertMember(this.fieldsByType.get(scope.name), { ...symbol, kind: "field" });
  }

  private visitClassMember(member: ClassMemberNode, scope: SourceScope, owner: string): void {
    const targetOwner = member.static ? `typeof ${owner}` : owner;
    const kind = member.memberKind === "getter" ? "property" : "method";
    const symbol = addSymbol(scope, member.fn.name, kind, member.fn.nameSpan.line, member.fn.nameSpan.column, memberType(member));
    if (member.memberKind !== "constructor") upsertMember(this.fieldsByType.get(targetOwner), symbol);
    const child = this.childScope(scope, member.fn.name, "function", member.fn.span.line, member.fn.span.column);
    symbol.scope = child;
    addSymbol(child, "this", "variable", member.fn.span.line, member.fn.span.column, targetOwner);
    this.addParams(child, member.fn);
    for (const stmt of member.fn.body) {
      this.visitThisField(stmt, child, targetOwner);
      this.visitNode(stmt, child);
    }
    child.endLine = endLine(member.fn.body, member.fn.span.line);
  }

  private visitExpression(node: ASTNode, scope: SourceScope, span: { line: number; column: number }): void {
    if (node.type === NodeType.ArrowFunctionExpression) this.visitArrowParams(node, scope, span);
  }

  private visitThisField(node: SemanticNode, scope: SourceScope, owner: string): void {
    if (node.kind !== "Expr" || node.value.type !== NodeType.AssignmentExpression) return;
    const target = node.value.target as ASTNode;
    if (target.type !== NodeType.MemberExpression || (target.object as ASTNode)?.type !== NodeType.ThisExpression || typeof target.property !== "string") return;
    const at = nodePosition(target, node.span);
    upsertMember(this.fieldsByType.get(owner), {
      name: target.property,
      kind: "field",
      line: at.line,
      column: at.column,
      typeName: this.localType(target.property, at.line),
    });
  }

  private visitArrowParams(node: ASTNode, scope: SourceScope, span: { line: number; column: number }): void {
    for (const param of node.params as unknown[]) {
      const name = paramName(param);
      if (name) addSymbol(scope, name, "parameter", span.line, span.column, this.localType(name, span.line));
    }
  }

  private addParams(scope: SourceScope, fn: FunctionNode): void {
    for (const param of fn.params) addSymbol(scope, param.name, "parameter", param.span.line, param.span.column, cleanType(param.type));
  }

  private childScope(parent: SourceScope, name: string, kind: ScopeKind, line: number, column: number): SourceScope {
    const scope = makeScope(name, parent, line, line, Math.max(0, column - 1), kind);
    parent.children.push(scope);
    this.scopes.push(scope);
    return scope;
  }

  private localType(name: string, line: number): string | null {
    const type = this.inferred.locals.get(`${name}:${line}`)?.[0]?.type;
    return type && type !== "any" ? type : null;
  }
}

function collectInferredTypes(symbols: Iterable<InferredSymbolInput>): InferredTypes {
  const locals = new Map<string, InferredLocal[]>();
  const members = new Map<string, string>();
  for (const symbol of symbols) {
    if (symbol.name.includes(".")) members.set(symbol.name, symbol.type);
    else {
      const key = `${symbol.name}:${symbol.line}`;
      const entries = locals.get(key) ?? [];
      entries.push(symbol);
      locals.set(key, entries);
    }
  }
  return { locals, members };
}

function makeScope(name: string, parent: SourceScope | null, startLine: number, endLine: number, indent: number, kind: ScopeKind = "scope"): SourceScope {
  return { name, kind, parent, children: [], symbols: [], startLine, endLine, indent };
}

function addSymbol(
  scope: SourceScope,
  name: string,
  kind: SymbolKind,
  line: number,
  column: number,
  typeName: string | null = null,
  visibility: Pick<SourceSymbol, "visibleFromLine" | "visibleFromColumn"> = {},
): SourceSymbol {
  const symbol: SourceSymbol = { name, kind, line, column, typeName, ...visibility };
  scope.symbols.push(symbol);
  return symbol;
}

function upsertMember(members: SourceSymbol[] | undefined, member: SourceSymbol): void {
  if (!members) return;
  const index = members.findIndex((entry) => entry.name === member.name);
  if (index >= 0) members[index] = member;
  else members.push(member);
}

function upsertInferredMember(members: SourceSymbol[] | undefined, member: SourceSymbol): void {
  if (!members) return;
  const existing = members.find((entry) => entry.name === member.name);
  if (existing) {
    existing.typeName = member.typeName;
    if (existing.line <= 0 && member.line > 0) {
      existing.line = member.line;
      existing.column = member.column;
    }
    return;
  }
  members.push(member);
}

function inheritedMembers(fieldsByType: Map<string, SourceSymbol[]>, parent: string | undefined): SourceSymbol[] {
  return parent ? (fieldsByType.get(parent) ?? []).map((member) => ({ ...member })) : [];
}

function builtinFieldsByType(): Map<string, SourceSymbol[]> {
  const fields = new Map<string, SourceSymbol[]>();
  const env = createTypeEnv();
  const owners = new Set<string>();
  for (const name of env.interfaces.keys()) owners.add(name);
  for (const type of ["Array", "DataFrame", "Tensor", "String", "Object", "Promise", "Math", "JSON"]) owners.add(type);
  for (const owner of owners) {
    const members = fields.get(owner) ?? [];
    for (const candidate of builtinMethodCandidates(owner)) {
      const method = builtinMethod(owner, candidate, env);
      if (!method) continue;
      members.push({
        name: candidate,
        kind: method.getter ? "property" : "method",
        line: 0,
        column: 0,
        typeName: method.getter ? method.returns : signatureType(method.signature),
      });
    }
    if (members.length) fields.set(owner, members);
  }
  for (const [typeName, shape] of createTypeEnv().interfaces) {
    const members = fields.get(typeName) ?? [];
    for (const [name, binding] of shape.fields) upsertMember(members, builtinField(name, binding));
    if (members.length) fields.set(typeName, members);
  }
  return fields;
}

function builtinMethodCandidates(owner: string): string[] {
  return TERA_PSEUDO_TYPES[owner as keyof typeof TERA_PSEUDO_TYPES]?.methods.map((method) => method.name) ?? [];
}

function builtinField(name: string, binding: Binding): SourceSymbol {
  return { name, kind: "field", line: 0, column: 0, typeName: binding.type };
}

function endLine(nodes: Array<SemanticNode | FunctionNode>, fallback: number): number {
  let line = fallback;
  for (const node of nodes) {
    line = Math.max(line, node.span.line);
    if ("body" in node) line = Math.max(line, endLine(node.body, node.span.line));
    if (node.kind === "Class") line = Math.max(line, endLine(node.members.map((member) => member.fn), node.span.line));
  }
  return line + 1;
}

function cleanType(type: string | undefined): string | null {
  return type?.trim() || null;
}

function returnType(type: string): string | null {
  const cleaned = cleanType(type);
  return cleaned === "any" ? null : cleaned;
}

function memberType(member: ClassMemberNode): string | null {
  const returns = returnType(member.fn.returns);
  if (member.memberKind === "getter") return returns;
  if (member.memberKind === "setter") return cleanType(member.fn.params[0]?.type);
  const params = member.fn.params.map((param) => cleanType(param.type) ?? "any").join(", ");
  return `(${params}) -> ${returns ?? "any"}`;
}

function membersFor(typeName: string, fieldsByType: Map<string, SourceSymbol[]>): SourceSymbol[] {
  const type = typeName.trim();
  const union = splitUnionTopLevel(type);
  if (union.length > 1) return commonMembers(union.map((part) => membersFor(part, fieldsByType)));
  return objectTypeMembers(type) ?? fieldsByType.get(type) ?? [];
}

function commonMembers(groups: SourceSymbol[][]): SourceSymbol[] {
  const [first, ...rest] = groups;
  if (!first) return [];
  const out: SourceSymbol[] = [];
  for (const member of first) {
    const matches = rest.map((group) => group.find((item) => item.name === member.name)).filter((item): item is SourceSymbol => !!item);
    if (matches.length !== rest.length) continue;
    const types = [member, ...matches].map((item) => item.typeName).filter((type): type is string => !!type);
    out.push({ ...member, typeName: types.length ? unionTypeNames(types) : member.typeName });
  }
  return out;
}

function unionTypeNames(types: string[]): string {
  const out: string[] = [];
  for (const type of types) {
    for (const part of splitUnionTopLevel(type)) if (!out.includes(part)) out.push(part);
  }
  return out.join(" | ");
}

function splitUnionTopLevel(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
    else if (ch === "|" && depth === 0) {
      out.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(source.slice(start).trim());
  return out.filter(Boolean);
}

function objectTypeMembers(typeName: string): SourceSymbol[] | null {
  const type = typeName.trim();
  if (!type.startsWith("{") || !type.endsWith("}")) return null;
  const out: SourceSymbol[] = [];
  for (const part of splitTopLevel(type.slice(1, -1))) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const name = part.slice(0, colon).trim().replace(/\?$/, "");
    if (isIdentifier(name)) out.push({ name, kind: "field", line: 0, column: 0, typeName: part.slice(colon + 1).trim() });
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
    else if (ch === "," && depth === 0) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

function findScopeAt(scope: SourceScope, line: number): SourceScope {
  for (const child of scope.children) {
    if (line >= child.startLine && line <= child.endLine) return findScopeAt(child, line);
  }
  return scope;
}

function resolveName(root: SourceScope, name: string, line: number, column: number): SourceSymbol | null {
  let scope: SourceScope | null = findScopeAt(root, line);
  while (scope) {
    let best: SourceSymbol | null = null;
    for (const symbol of scope.symbols) {
      if (symbol.name !== name || !isVisibleAt(symbol, line, column)) continue;
      if (!best || symbol.line > best.line || (symbol.line === best.line && symbol.column > best.column)) best = symbol;
    }
    if (best) return best;
    scope = scope.parent;
  }
  return null;
}

function isVisibleAt(symbol: SourceSymbol, line: number, column: number): boolean {
  if (symbol.line < line) return true;
  if (symbol.line === line && symbol.column <= column) return true;
  if (!symbol.visibleFromLine || !symbol.visibleFromColumn) return false;
  if (symbol.visibleFromLine > line) return false;
  if (symbol.visibleFromLine === line && symbol.visibleFromColumn > column) return false;
  return true;
}

type PositionedNode = ASTNode & { __line?: number; __column?: number };

function nodePosition(node: ASTNode, fallback: { line: number; column: number }): { line: number; column: number } {
  const positioned = node as PositionedNode;
  return { line: positioned.__line ?? fallback.line, column: positioned.__column ?? fallback.column };
}

function paramName(param: unknown): string | null {
  if (typeof param === "string") return param;
  if (!param || typeof param !== "object") return null;
  const item = param as { name?: unknown };
  return typeof item.name === "string" ? item.name : null;
}

function isIdentifier(value: string): boolean {
  if (!value) return false;
  if (!/[A-Za-z_$]/.test(value[0])) return false;
  for (let i = 1; i < value.length; i++) if (!/[\w$]/.test(value[i])) return false;
  return true;
}

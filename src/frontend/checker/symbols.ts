import { astChildren, NodeType, type ASTNode } from "../ast/index.js";
import { TERA_PRIMITIVE_PSEUDO_TYPES, TERA_PSEUDO_TYPES, type TeraPseudoTypeSpec } from "../../../data/tera-language-spec.js";
import { lowerToSemanticProgram } from "./semantic-lowering.js";
import type { ClassFieldNode, ClassMemberNode, FunctionNode, SemanticNode } from "./semantic-ast.js";
import { builtinMethod, createTypeEnv, signatureType, type Binding } from "./type-system.js";
import type { ExternalBuiltinSignature, ExternalInterface, ExternalModuleSurface, ExternalTypeAlias } from "./binder.js";
import { DEFAULT_CLASS_VISIBILITY, type ClassVisibility } from "../../core/class-visibility.js";
import { splitTopLevel } from "../../core/type-text.js";
import type { SyntaxPlugin } from "../parser/extensions.js";
import { maskNonCodeSource } from "../source-context.js";

const SYNTHETIC_LINE = 0;
const UNION_SEPARATOR = "|";
const MEMBER_SEPARATOR = ",";

export type SymbolPosition = { line: number; character: number };

export type SymbolKind = "function" | "model" | "module" | "type" | "variable" | "parameter" | "field" | "method" | "property";

export type ScopeKind = "scope" | "function" | "class" | "model" | "interface" | "type";

export type SourceSymbol = {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  typeName: string | null;
  visibleFromLine?: number;
  visibleFromColumn?: number;
  visibility?: ClassVisibility;
  owner?: string;
  scope?: SourceScope;
};

export function symbolStartsAt(symbol: SourceSymbol | null, position: SymbolPosition): boolean {
  return symbol?.line === position.line + 1 && symbol.column === position.character + 1;
}

export function isFieldSymbolAt(symbol: SourceSymbol | null, position: SymbolPosition): boolean {
  return symbol?.kind === "field" && symbolStartsAt(symbol, position);
}

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
  resolveField(typeName: string | null, fieldName: string, position?: SymbolPosition): SourceSymbol | null;
  membersOf(typeName: string | null, position?: SymbolPosition): SourceSymbol[];
};

export type BuildSourceSymbolTableOptions = {
  syntaxPlugins?: readonly SyntaxPlugin[];
  aliases?: readonly ExternalTypeAlias[];
  interfaces?: readonly ExternalInterface[];
  imports?: ExternalModuleSurface;
};

export function buildSourceSymbolTable(source: string, inferredSymbols: Iterable<InferredSymbolInput> = [], options: BuildSourceSymbolTableOptions = {}): SourceSymbolTable {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const inferred = collectInferredTypes(inferredSymbols);
  const builder = new SymbolTableBuilder(lines, inferred, options);
  try {
    builder.visitProgram(lowerToSemanticProgram(source, { syntaxPlugins: options.syntaxPlugins }).body);
  } catch {
    builder.materializeInferredLocals();
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

type ImportedSourceSymbol = {
  kind: SymbolKind;
  typeName: string | null;
};

const PSEUDO_MEMBER_OWNER_BY_LOWER = new Map([
  ...Object.keys(TERA_PSEUDO_TYPES).map((owner) => [owner.toLowerCase(), owner] as const),
  ...Object.entries(TERA_PRIMITIVE_PSEUDO_TYPES).map(([primitive, owner]) => [primitive.toLowerCase(), owner] as const),
]);

class SymbolTableBuilder {
  root: SourceScope;
  scopes: SourceScope[];
  fieldsByType = builtinFieldsByType();
  parentsByType = new Map<string, string>();
  aliasesByType = new Map<string, string>();
  typeParamsByOwner = new Map<string, string[]>();
  importedSymbols = new Map<string, ImportedSourceSymbol>();
  source: string;
  lexicalSource: string;
  lineStarts: number[];

  constructor(private readonly lines: string[], private readonly inferred: InferredTypes, options: BuildSourceSymbolTableOptions) {
    this.source = lines.join("\n");
    this.lexicalSource = maskNonCodeSource(this.source);
    this.lineStarts = lineStartsOf(this.source);
    this.root = makeScope("<root>", null, 1, lines.length + 1, 0);
    this.scopes = [this.root];
    this.addExternalSurface({ aliases: options.aliases, interfaces: options.interfaces });
    if (options.imports !== undefined) {
      this.addExternalSurface(options.imports);
      this.addImportedSymbols(options.imports);
    }
  }

  visitProgram(nodes: SemanticNode[]): void {
    for (const node of nodes) this.visitNode(node, this.root);
  }

  materializeInferredLocals(): void {
    const declared = new Map<SourceScope, Set<string>>();
    const declaredIn = (scope: SourceScope): Set<string> => {
      let known = declared.get(scope);
      if (known === undefined) {
        known = new Set(
          scope.symbols.map((symbol) => symbolPosition(symbol.name, symbol.line, symbol.column)),
        );
        declared.set(scope, known);
      }
      return known;
    };

    for (const locals of this.inferred.locals.values()) {
      for (const local of locals) {
        const scope = findScopeAt(this.root, local.line, this.lines);
        const known = declaredIn(scope);
        const position = symbolPosition(local.name, local.line, local.column);
        if (known.has(position)) continue;
        known.add(position);
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
    const lines = this.lines;
    const fieldsByType = this.fieldsByType;
    const parentsByType = this.parentsByType;
    return {
      root,
      scopes: this.scopes,
      flat: this.scopes.flatMap((scope) => scope.symbols),
      findScopeAt: (position) => findScopeAt(root, position.line + 1, lines),
      resolve: (name, position) => resolveName(root, name, position.line + 1, position.character + 1, lines),
      resolveField: (typeName, fieldName, position) => {
        const scope = position ? findScopeAt(root, position.line + 1, lines) : null;
        return (typeName ? membersFor(typeName, fieldsByType, this.aliasesByType, this.typeParamsByOwner).find((field) =>
          field.name === fieldName && sourceAccessAllowed(field, typeName, scope, parentsByType),
        ) : null) ?? null;
      },
      membersOf: (typeName, position) => {
        const scope = position ? findScopeAt(root, position.line + 1, lines) : null;
        return typeName ? membersFor(typeName, fieldsByType, this.aliasesByType, this.typeParamsByOwner).filter((field) =>
          sourceAccessAllowed(field, typeName, scope, parentsByType) && !isHiddenMember(typeName, field.name),
        ) : [];
      },
    };
  }

  private addExternalSurface(surface: Pick<ExternalModuleSurface, "aliases" | "interfaces">): void {
    for (const alias of surface.aliases ?? []) {
      this.aliasesByType.set(alias.name, alias.type);
      this.typeParamsByOwner.set(alias.name, alias.typeParams ?? []);
    }
    for (const spec of surface.interfaces ?? []) {
      const members = this.fieldsByType.get(spec.name) ?? [];
      this.typeParamsByOwner.set(spec.name, spec.typeParams ?? []);
      for (const [name, binding] of Object.entries(spec.fields)) {
        upsertMember(members, builtinField(name, { type: binding.type, optional: binding.optional ?? false }));
      }
      this.fieldsByType.set(spec.name, members);
    }
  }

  private addImportedSymbols(surface: ExternalModuleSurface): void {
    for (const alias of surface.aliases ?? []) {
      this.importedSymbols.set(alias.name, { kind: "type", typeName: cleanType(alias.type) });
    }
    for (const spec of surface.interfaces ?? []) {
      this.importedSymbols.set(spec.name, { kind: "type", typeName: spec.name });
    }
    for (const spec of surface.builtins ?? []) {
      this.importedSymbols.set(spec.name, { kind: "function", typeName: externalReturnType(spec) });
    }
    for (const value of surface.values ?? []) {
      this.importedSymbols.set(value.name, { kind: "variable", typeName: cleanType(value.type) });
    }
  }

  private visitImport(node: Extract<SemanticNode, { kind: "Import" }>, scope: SourceScope): void {
    for (const binding of node.bindings) {
      const imported = this.importedSymbols.get(binding.local);
      if (imported === undefined) continue;
      addSymbol(
        scope,
        binding.local,
        imported.kind,
        binding.span.line,
        binding.span.column,
        imported.typeName,
      );
    }
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
        this.visitTypeAlias(node, scope);
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
      case "Import":
        this.visitImport(node, scope);
        break;
      case "Expr":
        this.visitExpression(node.value, scope, node.span);
        break;
      case "Jump":
        if (node.value) this.visitExpression(node.value, scope, node.span);
        break;
      case "Return":
        break;
    }
  }

  private visitFunction(node: FunctionNode, scope: SourceScope): SourceScope {
    const symbol = addSymbol(scope, node.name, "function", node.nameSpan.line, node.nameSpan.column, returnType(node.returns));
    const child = this.childScope(scope, node.name, "function", node.span.line, node.span.column);
    symbol.scope = child;
    this.addTypeParams(child, node.name, node.nameSpan, node.typeParams);
    this.addParams(child, node);
    for (const stmt of node.body) this.visitNode(stmt, child);
    child.endLine = endLine(node.body, node.span.line);
    return child;
  }

  private visitTypeAlias(node: Extract<SemanticNode, { kind: "TypeAlias" }>, scope: SourceScope): void {
    const symbol = addSymbol(scope, node.name, "type", node.nameSpan.line, node.nameSpan.column, node.type);
    this.aliasesByType.set(node.name, node.type);
    this.typeParamsByOwner.set(node.name, node.typeParams);
    const typeMembers = typeLiteralSymbols(this.source, this.lexicalSource, this.lineStarts, node);
    const shapeMembers = typeMembers.filter((member) => member.exported);
    if (shapeMembers.length) this.fieldsByType.set(node.name, []);
    if (node.typeParams.length === 0 && typeMembers.length === 0) return;
    const child = this.childScope(scope, node.name, "type", node.span.line, node.span.column);
    symbol.scope = child;
    this.addTypeParams(child, node.name, node.nameSpan, node.typeParams);
    const members = this.fieldsByType.get(node.name);
    for (const member of typeMembers) {
      const added = addSymbol(child, member.name, member.kind, member.line, member.column, member.typeName);
      if (member.exported) upsertMember(members, added);
    }
    child.endLine = typeLiteralEndLine(this.lexicalSource, this.lineStarts, node) ?? node.span.line;
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
    if (node.parent) this.parentsByType.set(node.name, node.parent);
    this.fieldsByType.set(node.name, inheritedMembers(this.fieldsByType, node.parent));
    this.fieldsByType.set(staticType, inheritedMembers(this.fieldsByType, node.parent ? `typeof ${node.parent}` : undefined));
    for (const field of node.fields) this.visitClassField(field, child, node.name);
    for (const member of node.members) this.visitClassMember(member, child, node.name, node.parent);
    child.endLine = endLine([...node.fields, ...node.members.map((member) => member.fn)], node.span.line);
  }

  private visitInterface(node: Extract<SemanticNode, { kind: "Interface" }>, scope: SourceScope): void {
    const symbol = addSymbol(scope, node.name, "module", node.nameSpan.line, node.nameSpan.column);
    const child = this.childScope(scope, node.name, "interface", node.span.line, node.span.column);
    symbol.scope = child;
    const members = inheritedMembers(this.fieldsByType, node.parents[0]);
    this.fieldsByType.set(node.name, members);
    this.typeParamsByOwner.set(node.name, node.typeParams);
    this.addTypeParams(child, node.name, node.nameSpan, node.typeParams);
    for (const field of node.fields) {
      const member = addSymbol(child, field.name, "field", field.span.line, field.span.column, cleanType(field.type));
      upsertMember(members, member);
    }
    child.endLine = endLine(node.fields, node.span.line);
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

  private visitClassMember(member: ClassMemberNode, scope: SourceScope, owner: string, parent: string | undefined): void {
    const targetOwner = member.static ? `typeof ${owner}` : owner;
    const kind = member.memberKind === "getter" ? "property" : "method";
    const symbol = addSymbol(scope, member.fn.name, kind, member.fn.nameSpan.line, member.fn.nameSpan.column, memberType(member), {}, {
      visibility: member.visibility ?? DEFAULT_CLASS_VISIBILITY,
      owner,
    });
    if (member.memberKind !== "constructor") upsertMember(this.fieldsByType.get(targetOwner), symbol);
    const child = this.childScope(scope, member.fn.name, "function", member.fn.span.line, member.fn.span.column);
    symbol.scope = child;
    addSymbol(child, "this", "variable", SYNTHETIC_LINE, SYNTHETIC_LINE, targetOwner);
    if (parent && !member.static) addSymbol(child, "super", "variable", SYNTHETIC_LINE, SYNTHETIC_LINE, parent);
    this.addParams(child, member.fn);
    for (const stmt of member.fn.body) {
      this.visitThisField(stmt, child, targetOwner);
      this.visitNode(stmt, child);
    }
    child.endLine = endLine(member.fn.body, member.fn.span.line);
  }

  private visitClassField(field: ClassFieldNode, scope: SourceScope, owner: string): void {
    const targetOwner = field.static ? `typeof ${owner}` : owner;
    const symbol = addSymbol(scope, field.name, "field", field.nameSpan.line, field.nameSpan.column, cleanType(field.declaredType) ?? this.localType(field.name, field.span.line), {}, {
      visibility: field.visibility,
      owner,
    });
    upsertMember(this.fieldsByType.get(targetOwner), symbol);
  }

  private visitExpression(node: ASTNode, scope: SourceScope, span: { line: number; column: number }): void {
    const visit = (current: ASTNode): void => {
      if (current.type === NodeType.ArrowFunctionExpression) this.visitArrowParams(current, scope, nodePosition(current, span));
      for (const child of astChildren(current)) visit(child);
    };
    visit(node);
  }

  private visitThisField(node: SemanticNode, scope: SourceScope, owner: string): void {
    if (node.kind !== "Expr" || node.value.type !== NodeType.AssignmentExpression) return;
    const target = node.value.target as ASTNode;
    if (target.type !== NodeType.MemberExpression || (target.object as ASTNode)?.type !== NodeType.ThisExpression || typeof target.property !== "string") return;
    const members = this.fieldsByType.get(owner);
    const existing = members?.find((member) => member.name === target.property);
    if (existing && existing.line > 0) return;
    const at = nodePosition(target, node.span);
    upsertMember(members, {
      name: target.property,
      kind: "field",
      line: at.line,
      column: at.column,
      typeName: existing?.typeName ?? this.localType(target.property, at.line),
      visibility: existing?.visibility,
      owner: existing?.owner,
    });
  }

  private visitArrowParams(node: ASTNode, scope: SourceScope, span: { line: number; column: number }): void {
    const info = arrowParamInfo(node);
    if (info.length) {
      for (const param of info) {
        if (!param.name) continue;
        const line = param.line ?? span.line;
        const column = param.column ?? span.column;
        addSymbol(scope, param.name, "parameter", line, column, cleanType(param.type) ?? this.localType(param.name, line));
      }
      return;
    }
    for (const param of node.params as unknown[]) {
      const name = paramName(param);
      if (name) addSymbol(scope, name, "parameter", span.line, span.column, this.localType(name, span.line));
    }
  }

  private addParams(scope: SourceScope, fn: FunctionNode): void {
    for (const param of fn.params) addSymbol(scope, param.name, "parameter", param.span.line, param.span.column, cleanType(param.type));
  }

  private addTypeParams(scope: SourceScope, owner: string, ownerSpan: { line: number; column: number }, params: readonly string[]): void {
    const positions = typeParameterPositions(this.lines, owner, ownerSpan, params);
    for (const param of params) {
      const name = typeParamName(param);
      if (name === null) continue;
      const at = positions.get(name) ?? ownerSpan;
      addSymbol(scope, name, "type", at.line, at.column);
    }
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
  access: Pick<SourceSymbol, "visibility" | "owner"> = {},
): SourceSymbol {
  const symbol: SourceSymbol = { name, kind, line, column, typeName, ...visibility, ...access };
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
  for (const type of Object.keys(TERA_PSEUDO_TYPES)) owners.add(type);
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
  return { name, kind: binding.type.includes("->") ? "method" : "field", line: 0, column: 0, typeName: binding.type };
}

function endLine(nodes: Array<SemanticNode | FunctionNode | ClassFieldNode | { span: { line: number } }>, fallback: number): number {
  let line = fallback;
  for (const node of nodes) {
    line = Math.max(line, node.span.line);
    if ("body" in node) line = Math.max(line, endLine(node.body, node.span.line));
    if ("kind" in node && node.kind === "Class") line = Math.max(line, endLine(node.members.map((member) => member.fn), node.span.line));
  }
  return line;
}

function cleanType(type: string | undefined): string | null {
  return type?.trim() || null;
}

function externalReturnType(spec: ExternalBuiltinSignature): string | null {
  return returnType(spec.returns ?? "any");
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

function membersFor(
  typeName: string,
  fieldsByType: Map<string, SourceSymbol[]>,
  aliasesByType: ReadonlyMap<string, string> = new Map(),
  typeParamsByOwner: ReadonlyMap<string, string[]> = new Map(),
): SourceSymbol[] {
  const type = typeName.trim();
  const alias = aliasesByType.get(type);
  if (alias !== undefined && alias !== type) {
    const sourceMembers = fieldsByType.get(type);
    if (sourceMembers?.length) return sourceMembers;
    return membersFor(alias, fieldsByType, aliasesByType, typeParamsByOwner);
  }
  const union = splitUnionTopLevel(type);
  if (union.length > 1) {
    const concrete = union.filter((part) => !isNullishType(part));
    return commonMembers((concrete.length ? concrete : union).map((part) => membersFor(part, fieldsByType, aliasesByType, typeParamsByOwner)));
  }
  if (arrayElementType(type)) return fieldsByType.get("Array") ?? [];
  const generic = genericType(type);
  if (generic) {
    const owner = canonicalPseudoMemberOwner(generic.name);
    const members = fieldsByType.get(owner);
    const params = typeParamsFor(owner, typeParamsByOwner);
    if (members?.length) return params.length ? instantiateMembers(members, params, generic.args) : members;
  }
  return objectTypeMembers(type) ?? fieldsByType.get(type) ?? fieldsByType.get(canonicalPseudoMemberOwner(type)) ?? [];
}

function arrayElementType(typeName: string): string | null {
  const type = typeName.trim();
  return type.endsWith("[]") ? type.slice(0, -2).trim() : null;
}

function canonicalPseudoMemberOwner(typeName: string): string {
  return PSEUDO_MEMBER_OWNER_BY_LOWER.get(ownerFromType(typeName).toLowerCase()) ?? typeName;
}

function isNullishType(typeName: string): boolean {
  const type = typeName.trim();
  return type === "null" || type === "undefined";
}

function sourceAccessAllowed(
  symbol: SourceSymbol,
  typeName: string,
  scope: SourceScope | null,
  parentsByType: Map<string, string>,
): boolean {
  const visibility = symbol.visibility ?? "public";
  if (visibility === "public") return true;
  const caller = currentClassScopeName(scope);
  if (!caller) return false;
  const owner = symbol.owner ?? ownerFromType(typeName);
  if (visibility === "private") return caller === owner;
  return caller === owner || sourceClassExtends(caller, owner, parentsByType);
}

function currentClassScopeName(scope: SourceScope | null): string | null {
  for (let current = scope; current; current = current.parent) {
    if (current.kind === "class") return current.name;
  }
  return null;
}

function sourceClassExtends(typeName: string, parentName: string, parentsByType: Map<string, string>): boolean {
  let current = parentsByType.get(typeName);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === parentName) return true;
    seen.add(current);
    current = parentsByType.get(current);
  }
  return false;
}

function isHiddenMember(typeName: string, memberName: string): boolean {
  if (memberName !== "value") return false;
  const owner = ownerFromType(typeName);
  return owner === "ReactiveSignal" || owner === "ReactiveComputed" || owner === "ReactiveResource";
}

function ownerFromType(typeName: string): string {
  const cleaned = typeName.trim().replace(/^typeof\s+/, "");
  const generic = cleaned.match(/^([A-Za-z_$][\w$]*)\s*</);
  return generic ? generic[1] : cleaned;
}

function genericType(typeName: string): { name: string; args: string[] } | null {
  const type = typeName.trim();
  const match = type.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
  if (!match) return null;
  return { name: match[1], args: splitTopLevel(match[2], MEMBER_SEPARATOR).map((arg) => arg.trim()) };
}

function typeParamsFor(owner: string, external: ReadonlyMap<string, string[]> = new Map()): string[] {
  const externalParams = external.get(owner);
  if (externalParams !== undefined) return externalParams;
  const pseudo = (TERA_PSEUDO_TYPES as Record<string, TeraPseudoTypeSpec>)[owner]?.typeParams;
  if (pseudo?.length) return pseudo;
  return createTypeEnv().interfaces.get(owner)?.typeParams ?? [];
}

function instantiateMembers(members: SourceSymbol[], params: string[], args: string[]): SourceSymbol[] {
  return members.map((member) => ({
    ...member,
    typeName: member.typeName ? substituteTypeParams(member.typeName, params, args) : member.typeName,
  }));
}

function substituteTypeParams(typeName: string, params: string[], args: string[]): string {
  let out = typeName;
  for (let i = 0; i < params.length; i++) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(params[i])}\\b`, "g"), args[i] ?? "any");
  }
  return out;
}

function symbolPosition(name: string, line: number, column: number): string {
  return `${name}:${line}:${column}`;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commonMembers(groups: SourceSymbol[][]): SourceSymbol[] {
  const [first, ...rest] = groups;
  if (!first) return [];
  const byName = rest.map(
    (group) => new Map(group.map((item) => [item.name, item] as const)),
  );
  const out: SourceSymbol[] = [];
  for (const member of first) {
    const matches: SourceSymbol[] = [];
    for (const group of byName) {
      const found = group.get(member.name);
      if (found !== undefined) matches.push(found);
    }
    if (matches.length !== rest.length) continue;
    const types = [member, ...matches].map((item) => item.typeName).filter((type): type is string => !!type);
    out.push({ ...member, typeName: types.length ? unionTypeNames(types) : member.typeName });
  }
  return out;
}

function unionTypeNames(types: string[]): string {
  const out = new Set<string>();
  for (const type of types) {
    for (const part of splitUnionTopLevel(type)) out.add(part);
  }
  return [...out].join(` ${UNION_SEPARATOR} `);
}

function splitUnionTopLevel(source: string): string[] {
  return splitTopLevel(source, UNION_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

function objectTypeMembers(typeName: string): SourceSymbol[] | null {
  const type = typeName.trim();
  if (!type.startsWith("{") || !type.endsWith("}")) return null;
  const out: SourceSymbol[] = [];
  for (const part of splitTopLevel(type.slice(1, -1), MEMBER_SEPARATOR)) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const name = part.slice(0, colon).trim().replace(/\?$/, "");
    if (isIdentifier(name)) out.push({ name, kind: "field", line: 0, column: 0, typeName: part.slice(colon + 1).trim() });
  }
  return out;
}

function findScopeAt(scope: SourceScope, line: number, lines: string[]): SourceScope {
  for (const child of scope.children) {
    if (line < child.startLine || line > child.endLine) continue;
    if (line !== child.startLine && !indentedInto(lines, line, child.indent)) continue;
    return findScopeAt(child, line, lines);
  }
  return scope;
}

function indentedInto(lines: string[], line: number, indent: number): boolean {
  const text = lines[line - 1];
  if (text === undefined || text.trim() === "") return true;
  return text.length - text.trimStart().length > indent;
}

function resolveName(root: SourceScope, name: string, line: number, column: number, lines: string[]): SourceSymbol | null {
  let scope: SourceScope | null = findScopeAt(root, line, lines);
  while (scope) {
    let best: SourceSymbol | null = null;
    let hoisted: SourceSymbol | null = null;
    for (const symbol of scope.symbols) {
      if (symbol.name !== name) continue;
      if (isVisibleAt(symbol, line, column)) {
        if (!best || symbol.line > best.line || (symbol.line === best.line && symbol.column > best.column)) best = symbol;
      } else if (isHoistedSymbol(symbol)) {
        if (!hoisted || symbol.line < hoisted.line || (symbol.line === hoisted.line && symbol.column < hoisted.column)) hoisted = symbol;
      }
    }
    if (best) return best;
    if (hoisted) return hoisted;
    scope = scope.parent;
  }
  return null;
}

function isHoistedSymbol(symbol: SourceSymbol): boolean {
  return symbol.kind === "function" || symbol.kind === "model" || symbol.kind === "module" || symbol.kind === "type";
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

type ArrowParamInfo = {
  name: string;
  type?: string;
  line?: number;
  column?: number;
};

function arrowParamInfo(node: ASTNode): ArrowParamInfo[] {
  const info = (node as { _paramInfo?: unknown })._paramInfo;
  if (!Array.isArray(info)) return [];
  return info
    .filter((item): item is ArrowParamInfo => {
      if (!item || typeof item !== "object") return false;
      return typeof (item as ArrowParamInfo).name === "string";
    });
}

function isIdentifier(value: string): boolean {
  if (!value) return false;
  if (!/[A-Za-z_$]/.test(value[0])) return false;
  for (let i = 1; i < value.length; i++) if (!/[\w$]/.test(value[i])) return false;
  return true;
}

type TypeLiteralSymbol = {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  typeName: string | null;
  exported: boolean;
};

function typeLiteralSymbols(source: string, lexicalSource: string, lineStarts: readonly number[], node: Extract<SemanticNode, { kind: "TypeAlias" }>): TypeLiteralSymbol[] {
  const range = typeLiteralBodyRange(lexicalSource, lineStarts, node);
  if (range === null) return [];
  const symbols: TypeLiteralSymbol[] = [];
  let segmentStart = range.start + 1;
  let depth = 0;
  for (let cursor = segmentStart; cursor <= range.end; cursor++) {
    const char = cursor < range.end ? lexicalSource[cursor] : ",";
    if (char === "," && depth === 0) {
      symbols.push(...typeLiteralSegmentSymbols(source, lexicalSource, lineStarts, segmentStart, cursor));
      segmentStart = cursor + 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{" || char === "<") depth++;
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth = Math.max(0, depth - 1);
  }
  return symbols;
}

function typeLiteralBodyRange(source: string, lineStarts: readonly number[], node: Extract<SemanticNode, { kind: "TypeAlias" }>): { start: number; end: number } | null {
  const nameOffset = offsetOf(lineStarts, node.nameSpan.line, node.nameSpan.column);
  const equals = source.indexOf("=", nameOffset + node.name.length);
  if (equals < 0) return null;
  let cursor = equals + 1;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
  if (source[cursor] !== "{") return null;
  const end = matchingDelimiter(source, cursor, "{", "}");
  return end === null ? null : { start: cursor, end };
}

function typeLiteralEndLine(source: string, lineStarts: readonly number[], node: Extract<SemanticNode, { kind: "TypeAlias" }>): number | null {
  const range = typeLiteralBodyRange(source, lineStarts, node);
  return range === null ? null : positionOf(lineStarts, range.end).line;
}

function typeLiteralSegmentSymbols(source: string, lexicalSource: string, lineStarts: readonly number[], rawStart: number, rawEnd: number): TypeLiteralSymbol[] {
  const start = skipSpace(lexicalSource, rawStart, rawEnd);
  const end = trimEnd(lexicalSource, start, rawEnd);
  if (start >= end) return [];
  if (lexicalSource[start] === "[") return typeLiteralIndexerSymbols(source, lexicalSource, lineStarts, start, end);
  return typeLiteralFieldSymbol(source, lexicalSource, lineStarts, start, end);
}

function typeLiteralFieldSymbol(source: string, lexicalSource: string, lineStarts: readonly number[], start: number, end: number): TypeLiteralSymbol[] {
  if (!/[A-Za-z_$]/.test(lexicalSource[start] ?? "")) return [];
  let cursor = start + 1;
  while (cursor < end && /[\w$]/.test(lexicalSource[cursor])) cursor++;
  const name = source.slice(start, cursor);
  let afterName = skipSpace(lexicalSource, cursor, end);
  if (lexicalSource[afterName] === "?") afterName = skipSpace(lexicalSource, afterName + 1, end);
  if (lexicalSource[afterName] !== ":") return [];
  const typeStart = skipSpace(lexicalSource, afterName + 1, end);
  const typeEnd = trimEnd(lexicalSource, typeStart, end);
  const at = positionOf(lineStarts, start);
  return [{
    name,
    kind: "field",
    line: at.line,
    column: at.column,
    typeName: typeStart < typeEnd ? lexicalSource.slice(typeStart, typeEnd).trim() : null,
    exported: true,
  }];
}

function typeLiteralIndexerSymbols(source: string, lexicalSource: string, lineStarts: readonly number[], start: number, end: number): TypeLiteralSymbol[] {
  const close = matchingDelimiter(lexicalSource, start, "[", "]");
  if (close === null || close >= end) return [];
  let cursor = skipSpace(lexicalSource, start + 1, close);
  if (!/[A-Za-z_$]/.test(lexicalSource[cursor] ?? "")) return [];
  const nameStart = cursor;
  cursor++;
  while (cursor < close && /[\w$]/.test(lexicalSource[cursor])) cursor++;
  const name = source.slice(nameStart, cursor);
  cursor = skipSpace(lexicalSource, cursor, close);
  if (lexicalSource[cursor] !== ":") return [];
  const keyTypeStart = skipSpace(lexicalSource, cursor + 1, close);
  const keyTypeEnd = trimEnd(lexicalSource, keyTypeStart, close);
  const afterClose = skipSpace(lexicalSource, close + 1, end);
  if (lexicalSource[afterClose] !== ":") return [];
  const at = positionOf(lineStarts, nameStart);
  return [{
    name,
    kind: "parameter",
    line: at.line,
    column: at.column,
    typeName: keyTypeStart < keyTypeEnd ? lexicalSource.slice(keyTypeStart, keyTypeEnd).trim() : null,
    exported: false,
  }];
}

function matchingDelimiter(source: string, start: number, open: string, close: string): number | null {
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return cursor;
    }
  }
  return null;
}

function skipSpace(source: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && /\s/.test(source[cursor])) cursor++;
  return cursor;
}

function trimEnd(source: string, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && /\s/.test(source[cursor - 1])) cursor--;
  return cursor;
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") starts.push(index + 1);
  return starts;
}

function offsetOf(lineStarts: readonly number[], line: number, column: number): number {
  return (lineStarts[Math.max(0, line - 1)] ?? 0) + Math.max(0, column - 1);
}

function positionOf(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: offset - lineStarts[lineIndex] + 1 };
}

function typeParamName(source: string): string | null {
  return source.trim().match(/^[A-Za-z_$][\w$]*/)?.[0] ?? null;
}

function typeParameterPositions(
  lines: readonly string[],
  owner: string,
  ownerSpan: { line: number; column: number },
  params: readonly string[],
): Map<string, { line: number; column: number }> {
  const out = new Map<string, { line: number; column: number }>();
  const wanted = new Set(params.map(typeParamName).filter((name): name is string => name !== null));
  if (wanted.size === 0) return out;

  const line = lines[ownerSpan.line - 1] ?? "";
  const ownerStart = Math.max(0, ownerSpan.column - 1);
  const open = line.indexOf("<", ownerStart + owner.length);
  if (open < 0) return out;

  let depth = 0;
  for (let cursor = open; cursor < line.length; cursor++) {
    const char = line[cursor];
    if (char === "<") {
      depth++;
      continue;
    }
    if (char === ">") {
      depth--;
      if (depth <= 0) break;
      continue;
    }
    if (depth !== 1 || !/[A-Za-z_$]/.test(char)) continue;
    const start = cursor;
    cursor++;
    while (cursor < line.length && /[\w$]/.test(line[cursor])) cursor++;
    const name = line.slice(start, cursor);
    if (wanted.has(name) && !out.has(name)) out.set(name, { line: ownerSpan.line, column: start + 1 });
    cursor--;
  }
  return out;
}

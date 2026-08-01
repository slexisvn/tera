import {
  NodeType,
  type ASTNode,
  type BindingIdentifier,
  type BindingPattern,
  type ClassFieldNode as AstClassFieldNode,
  type ClassMethodNode as AstClassMemberNode,
  type FunctionParamInfo,
  type InterfaceFieldAstNode,
  type ModelFieldAstNode,
  type ModelSectionNode,
  type ParamNode,
} from "../ast/index.js";
import { parse } from "../parser/language.js";
import { DEFAULT_CLASS_VISIBILITY, type ClassVisibility } from "../../core/class-visibility.js";
import type {
  BlockNode,
  ClassFieldNode,
  ClassMemberKind,
  ClassMemberNode,
  ClassNode,
  DestructureNode,
  ExprNode,
  ForNode,
  FunctionNode,
  InterfaceNode,
  ModelNode,
  ParameterNode,
  ReturnNode,
  SemanticNode,
  SemanticProgram,
  TypeAliasNode,
  VarNode,
} from "./semantic-ast.js";
import { cleanType } from "./type-system.js";

type Positioned = {
  __line?: number;
  __column?: number;
  __nameLine?: number;
  __nameColumn?: number;
};

type FunctionAst = ASTNode & {
  name?: string | null;
  params?: ParamNode[];
  body?: ASTNode | ASTNode[];
  _paramInfo?: FunctionParamInfo[];
  _returnType?: string;
  _typeParams?: string[];
  visibility?: ClassVisibility;
  abstract?: boolean;
};

type ClassAst = ASTNode & {
  name?: string | null;
  superClass?: ASTNode | null;
  constructor?: FunctionAst | null;
  methods?: AstClassMemberNode[];
  fields?: AstClassFieldNode[];
  implements?: string[];
  abstract?: boolean;
};

type ModelAst = ASTNode & {
  name?: string | null;
  params?: ParamNode[];
  fields?: ModelFieldAstNode[];
  methods?: AstClassMemberNode[];
  sections?: ModelSectionNode[];
  _paramInfo?: FunctionParamInfo[];
};

const UNKNOWN_SPAN = { line: 1, column: 1 };

export function parseSemanticProgram(source: string): SemanticProgram {
  return astToSemanticProgram(parse(source));
}

export function astToSemanticProgram(ast: ASTNode): SemanticProgram {
  const body = ast.type === NodeType.Program ? statementsOf(ast).flatMap(toSemanticNodes) : toSemanticNodes(ast);
  return { body };
}

function toSemanticNodes(node: ASTNode | null | undefined): SemanticNode[] {
  if (!node) return [];
  switch (node.type) {
    case NodeType.TypeAliasDeclaration:
      return [typeAliasNode(node)];
    case NodeType.InterfaceDeclaration:
      return [interfaceNode(node)];
    case NodeType.FunctionDeclaration:
    case NodeType.LazyFunctionDeclaration:
      return [functionNode(node as FunctionAst)];
    case NodeType.ModelDeclaration:
      return [modelNode(node as ModelAst)];
    case NodeType.ClassDeclaration:
      return [classNode(node as ClassAst)];
    case NodeType.BlockStatement:
      return [blockNode(node)];
    case NodeType.IfStatement:
      return ifNodes(node);
    case NodeType.WhileStatement:
    case NodeType.DoWhileStatement:
      return [blockNode(node.body as ASTNode, node.test as ASTNode | undefined, spanOf(node))];
    case NodeType.ForInStatement:
      return forNode(node, "in");
    case NodeType.ForOfStatement:
      return forNode(node, "of");
    case NodeType.ForStatement:
      return forStatementNodes(node);
    case NodeType.TryStatement:
      return tryNodes(node);
    case NodeType.ReturnStatement:
      return [returnNode(node)];
    case NodeType.LetDeclaration:
    case NodeType.ConstDeclaration:
    case NodeType.VarDeclaration:
      return declarationNode(node);
    case NodeType.ObjectDestructuring:
    case NodeType.ArrayDestructuring:
      return destructureNode(node);
    case NodeType.ExpressionStatement:
      return expressionStatementNode(node);
    case NodeType.SwitchStatement:
      return switchNodes(node);
    case NodeType.ThrowStatement:
      return exprFrom(node.argument as ASTNode | undefined, spanOf(node));
    default:
      return [];
  }
}

function typeAliasNode(node: ASTNode): TypeAliasNode {
  return {
    kind: "TypeAlias",
    name: String(node.name ?? ""),
    typeParams: stringList(node.typeParams),
    type: cleanType(String(node.declaredType ?? "any")),
    span: spanOf(node),
    nameSpan: nameSpanOf(node),
  };
}

function interfaceNode(node: ASTNode): InterfaceNode {
  const fields = arrayOf<InterfaceFieldAstNode>(node.fields).map((field) => ({
    name: field.name,
    optional: !!field.optional,
    type: cleanType(field.type),
    span: spanOf(field),
  }));
  return {
    kind: "Interface",
    name: String(node.name ?? ""),
    typeParams: stringList(node.typeParams),
    parents: stringList(node.parents).map(cleanType),
    fields,
    indexers: arrayOf<{ keyType: string; valueType: string }>(node.indexers).map((indexer) => ({
      keyType: cleanType(indexer.keyType),
      valueType: cleanType(indexer.valueType),
    })),
    span: spanOf(node),
    nameSpan: nameSpanOf(node),
  };
}

function modelNode(node: ModelAst): ModelNode {
  return {
    kind: "Model",
    name: String(node.name ?? ""),
    params: paramsFromInfo(node._paramInfo, node.params),
    body: [
      ...arrayOf<ModelFieldAstNode>(node.fields).map(modelFieldVar),
      ...arrayOf<AstClassMemberNode>(node.methods).map((method) => functionNode(method.func as FunctionAst, method.name ?? undefined)),
      ...arrayOf<ModelSectionNode>(node.sections).map(modelSectionBlock),
    ],
    span: spanOf(node),
    nameSpan: nameSpanOf(node),
  };
}

function classNode(node: ClassAst): ClassNode {
  const constructorMember = node.constructor
    ? [classMemberNode(node.constructor, "constructor", false, node.constructor.visibility ?? DEFAULT_CLASS_VISIBILITY, !!node.constructor.explicitVisibility)]
    : [];
  return {
    kind: "Class",
    name: String(node.name ?? ""),
    parent: typeof node.superClass?.name === "string" ? node.superClass.name : undefined,
    implements: stringList(node.implements),
    abstract: !!node.abstract,
    fields: arrayOf<AstClassFieldNode>(node.fields).map(classFieldNode),
    members: [
      ...constructorMember,
      ...arrayOf<AstClassMemberNode>(node.methods).map((member) => {
        const kind: ClassMemberKind = member.kind === "get" ? "getter" : member.kind === "set" ? "setter" : "method";
        return classMemberNode(member.func as FunctionAst, kind, !!member.static, member.visibility ?? DEFAULT_CLASS_VISIBILITY, !!member.explicitVisibility, member.name ?? undefined, !!member.abstract);
      }),
    ],
    span: spanOf(node),
    nameSpan: nameSpanOf(node),
  };
}

function classMemberNode(
  fn: FunctionAst,
  memberKind: ClassMemberKind,
  isStatic: boolean,
  visibility: ClassVisibility,
  explicitVisibility: boolean,
  fallbackName?: string,
  isAbstract = !!fn.abstract,
): ClassMemberNode {
  return {
    memberKind,
    static: isStatic,
    visibility,
    explicitVisibility,
    abstract: isAbstract,
    fn: functionNode(fn, fallbackName),
  };
}

function classFieldNode(field: AstClassFieldNode): ClassFieldNode {
  return {
    name: field.name,
    declaredType: field.declaredType,
    value: field.init ?? undefined,
    static: !!field.static,
    visibility: field.visibility ?? DEFAULT_CLASS_VISIBILITY,
    explicitVisibility: !!field.explicitVisibility,
    span: spanOf(field),
    nameSpan: nameSpanOf(field),
  };
}

function modelFieldVar(field: ModelFieldAstNode): VarNode {
  return {
    kind: "Var",
    name: field.name,
    declaredType: field.declaredType,
    value: field.init,
    span: spanOf(field),
    nameSpan: nameSpanOf(field),
  };
}

function modelSectionBlock(section: ModelSectionNode): BlockNode {
  return {
    kind: "Block",
    body: semanticBody(section.body),
    span: spanOf(section),
  };
}

function functionNode(node: FunctionAst, fallbackName?: string): FunctionNode {
  return {
    kind: "Function",
    name: String(node.name ?? fallbackName ?? ""),
    typeParams: stringList(node._typeParams),
    params: paramsFromInfo(node._paramInfo, node.params),
    returns: cleanType(node._returnType ?? "any"),
    body: semanticBody(node.body),
    abstract: !!node.abstract,
    span: spanOf(node),
    nameSpan: nameSpanOf(node),
  };
}

function paramsFromInfo(info: FunctionParamInfo[] | undefined, params: ParamNode[] | undefined): ParameterNode[] {
  const parsed = arrayOf<FunctionParamInfo>(info);
  if (parsed.length) {
    return parsed.map((param) => ({
      name: param.name,
      type: cleanType(param.type ?? "any"),
      optional: !!param.optional,
      span: { line: param.line ?? UNKNOWN_SPAN.line, column: param.column ?? UNKNOWN_SPAN.column },
    }));
  }
  return arrayOf<ParamNode>(params).flatMap((param) => {
    const binding = paramBinding(param);
    return binding ? [{
      name: binding.name,
      type: "any",
      optional: binding.optional,
      span: binding.span,
    }] : [];
  });
}

function ifNodes(node: ASTNode): SemanticNode[] {
  const out: SemanticNode[] = [blockNode(node.consequent as ASTNode, node.test as ASTNode | undefined, spanOf(node))];
  const alternate = node.alternate as ASTNode | null | undefined;
  if (!alternate) return out;
  if (alternate.type === NodeType.IfStatement) out.push(...ifNodes(alternate));
  else out.push(blockNode(alternate, undefined, spanOf(alternate)));
  return out;
}

function forNode(node: ASTNode, mode: "in" | "of"): SemanticNode[] {
  const source = mode === "in" ? node.object : node.iterable;
  const binding = bindingName(node.variable as BindingPattern | undefined);
  if (!binding || !source || typeof source !== "object" || !("type" in source)) {
    return [blockNode(node.body as ASTNode, source as ASTNode | undefined, spanOf(node))];
  }
  return [{
    kind: "For",
    variable: binding.name,
    mode,
    iterable: source as ASTNode,
    body: semanticBody(node.body as ASTNode),
    span: spanOf(node),
    variableSpan: binding.span,
  } satisfies ForNode];
}

function forStatementNodes(node: ASTNode): SemanticNode[] {
  const init = node.init;
  const body = [
    ...toSemanticNodes(Array.isArray(init) ? undefined : init as ASTNode | undefined),
    blockNode(node.body as ASTNode, node.test as ASTNode | undefined, spanOf(node)),
    ...exprFrom(node.update as ASTNode | undefined, spanOf(node)),
  ];
  if (Array.isArray(init)) body.unshift(...(init as ASTNode[]).flatMap((entry) => toSemanticNodes(entry)));
  return body;
}

function tryNodes(node: ASTNode): SemanticNode[] {
  const out = [blockNode(node.block as ASTNode, undefined, spanOf(node))];
  const handler = node.handler as { param?: string | null; body?: ASTNode } | null | undefined;
  if (handler?.body) {
    out.push({
      kind: "Block",
      catchVariable: handler.param ?? undefined,
      catchVariableSpan: handler.param ? spanOf(node) : undefined,
      body: semanticBody(handler.body),
      span: spanOf(handler.body),
    });
  }
  if (node.finalizer) out.push(blockNode(node.finalizer as ASTNode, undefined, spanOf(node.finalizer as ASTNode)));
  return out;
}

function switchNodes(node: ASTNode): SemanticNode[] {
  const cases = arrayOf<ASTNode>(node.cases).map((entry) => {
    const test = entry.test as ASTNode | null | undefined;
    return {
      kind: "Block",
      test: test ?? undefined,
      body: semanticBody(entry.consequent as ASTNode[]),
      span: spanOf(entry),
    } satisfies BlockNode;
  });
  return [{
    kind: "Block",
    test: node.discriminant as ASTNode | undefined,
    body: cases,
    span: spanOf(node),
  }];
}

function blockNode(bodySource: ASTNode | ASTNode[] | null | undefined, test?: ASTNode, fallback = UNKNOWN_SPAN): BlockNode {
  return {
    kind: "Block",
    test,
    body: semanticBody(bodySource),
    span: spanOf(bodySource, fallback),
  };
}

function returnNode(node: ASTNode): ReturnNode {
  return {
    kind: "Return",
    value: node.argument as ASTNode | undefined,
    span: spanOf(node),
  };
}

function declarationNode(node: ASTNode): SemanticNode[] {
  const binding = bindingName(node.name as BindingPattern | undefined);
  const init = node.init as ASTNode | null | undefined;
  if (!binding) return [];
  if (!init) return [];
  return [{
    kind: "Var",
    name: binding.name,
    declaredType: typeof node.declaredType === "string" ? node.declaredType : undefined,
    value: init,
    span: spanOf(node),
    nameSpan: typeof node.name === "string" ? nameSpanOf(node) : binding.span,
  } satisfies VarNode];
}

function destructureNode(node: ASTNode): SemanticNode[] {
  const bindings = bindingNames(node.pattern as BindingPattern | undefined);
  const init = node.init as ASTNode | undefined;
  if (!bindings.names.length || !init) return [];
  return [{
    kind: "Destructure",
    names: bindings.names,
    value: init,
    span: spanOf(node),
    variableSpans: bindings.spans,
  } satisfies DestructureNode];
}

function expressionStatementNode(node: ASTNode): SemanticNode[] {
  const expression = node.expression as ASTNode | undefined;
  if (!expression) return [];
  if (expression.type === NodeType.AssignmentExpression) {
    const target = expression.target as ASTNode | undefined;
    if (target?.type === NodeType.Identifier) {
      return [{
        kind: "Var",
        name: String(target.name),
        value: expression.value as ASTNode,
        span: spanOf(node),
        nameSpan: spanOf(target),
      } satisfies VarNode];
    }
  }
  return [{
    kind: "Expr",
    value: expression,
    span: spanOf(node),
  } satisfies ExprNode];
}

function exprFrom(node: ASTNode | null | undefined, fallback = UNKNOWN_SPAN): ExprNode[] {
  return node ? [{ kind: "Expr", value: node, span: spanOf(node, fallback) }] : [];
}

function semanticBody(source: ASTNode | ASTNode[] | null | undefined): SemanticNode[] {
  return statementsOf(source).flatMap(toSemanticNodes);
}

function statementsOf(source: ASTNode | ASTNode[] | null | undefined): ASTNode[] {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (source.type === NodeType.Program || source.type === NodeType.BlockStatement) return arrayOf<ASTNode>(source.body);
  return [source];
}

function spanOf(source: unknown, fallback = UNKNOWN_SPAN): { line: number; column: number } {
  const positioned = source as Positioned | null | undefined;
  return {
    line: positioned?.__line ?? fallback.line,
    column: positioned?.__column ?? fallback.column,
  };
}

function nameSpanOf(source: unknown): { line: number; column: number } {
  const positioned = source as Positioned | null | undefined;
  return {
    line: positioned?.__nameLine ?? positioned?.__line ?? UNKNOWN_SPAN.line,
    column: positioned?.__nameColumn ?? positioned?.__column ?? UNKNOWN_SPAN.column,
  };
}

function bindingName(pattern: BindingPattern | undefined): { name: string; span: { line: number; column: number } } | null {
  if (typeof pattern === "string") return { name: pattern, span: UNKNOWN_SPAN };
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return null;
  if ((pattern as BindingIdentifier).kind === "id" && typeof (pattern as BindingIdentifier).name === "string") {
    return { name: (pattern as BindingIdentifier).name, span: spanOf(pattern) };
  }
  return null;
}

function bindingNames(pattern: BindingPattern | undefined): { names: string[]; spans: Array<{ line: number; column: number }> } {
  const names: string[] = [];
  const spans: Array<{ line: number; column: number }> = [];
  const visit = (item: BindingPattern | null | undefined) => {
    if (!item) return;
    const simple = bindingName(item);
    if (simple) {
      names.push(simple.name);
      spans.push(simple.span);
      return;
    }
    if (typeof item !== "object" || Array.isArray(item)) return;
    if (item.kind === "array") {
      for (const element of item.elements) visit(element);
      visit(item.rest as BindingPattern | null | undefined);
    } else if (item.kind === "object") {
      for (const prop of item.props) visit(prop.value);
      if (typeof item.rest === "string") {
        names.push(item.rest);
        spans.push(spanOf(item));
      } else {
        visit(item.rest as BindingPattern | null | undefined);
      }
    }
  };
  visit(pattern);
  return { names, spans };
}

function paramBinding(param: ParamNode): { name: string; optional: boolean; span: { line: number; column: number } } | null {
  if (typeof param === "string") return { name: param, optional: false, span: UNKNOWN_SPAN };
  if (!param || typeof param !== "object") return null;
  const record = param as { name?: unknown; default?: unknown; rest?: unknown };
  if (typeof record.name === "string") {
    return { name: record.name, optional: !!record.default || !!record.rest, span: spanOf(param) };
  }
  return null;
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

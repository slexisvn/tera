import type { ASTNode } from "../ast/index.js";

import type { ClassVisibility } from "../../core/class-visibility.js";

export type ParameterNode = {
  name: string;
  type: string;
  optional: boolean;
  span: SourceSpan;
};

export type SourceSpan = {
  line: number;
  column: number;
};

export type TypeAliasNode = {
  kind: "TypeAlias";
  name: string;
  typeParams: string[];
  type: string;
  span: SourceSpan;
  nameSpan: SourceSpan;
};

export type InterfaceFieldNode = {
  name: string;
  type: string;
  optional: boolean;
  span: SourceSpan;
};

export type InterfaceIndexNode = {
  keyType: string;
  valueType: string;
};

export type InterfaceNode = {
  kind: "Interface";
  name: string;
  typeParams: string[];
  parents: string[];
  fields: InterfaceFieldNode[];
  indexers: InterfaceIndexNode[];
  span: SourceSpan;
  nameSpan: SourceSpan;
};

export type FunctionNode = {
  kind: "Function";
  name: string;
  typeParams: string[];
  params: ParameterNode[];
  returns: string;
  body: SemanticNode[];
  abstract: boolean;
  async: boolean;
  span: SourceSpan;
  nameSpan: SourceSpan;
};

export type ModelNode = {
  kind: "Model";
  name: string;
  params: ParameterNode[];
  body: SemanticNode[];
  span: SourceSpan;
  nameSpan: SourceSpan;
};

export type ClassMemberKind = "constructor" | "method" | "getter" | "setter";

export type ClassMemberNode = {
  memberKind: ClassMemberKind;
  static: boolean;
  visibility: ClassVisibility;
  explicitVisibility: boolean;
  abstract: boolean;
  fn: FunctionNode;
};

export type ClassFieldNode = {
  name: string;
  declaredType?: string;
  value?: ASTNode;
  static: boolean;
  visibility: ClassVisibility;
  explicitVisibility: boolean;
  span: SourceSpan;
  nameSpan: SourceSpan;
};

export type ClassNode = {
  kind: "Class";
  name: string;
  parent?: string;
  implements: string[];
  abstract: boolean;
  fields: ClassFieldNode[];
  members: ClassMemberNode[];
  span: SourceSpan;
  nameSpan: SourceSpan;
};

export type BlockNode = {
  kind: "Block";
  test?: ASTNode;
  catchVariable?: string;
  catchVariableSpan?: SourceSpan;
  body: SemanticNode[];
  span: SourceSpan;
};

export type ForNode = {
  kind: "For";
  variable: string;
  mode: "in" | "of";
  iterable: ASTNode;
  body: SemanticNode[];
  span: SourceSpan;
  variableSpan: SourceSpan;
};

export type VarNode = {
  kind: "Var";
  name: string;
  declaredType?: string;
  value: ASTNode;
  span: SourceSpan;
  nameSpan: SourceSpan;
};

export type DestructureNode = {
  kind: "Destructure";
  names: string[];
  value: ASTNode;
  span: SourceSpan;
  variableSpans: SourceSpan[];
};

export type ReturnNode = {
  kind: "Return";
  value?: ASTNode;
  span: SourceSpan;
};

export type ExprNode = {
  kind: "Expr";
  value: ASTNode;
  span: SourceSpan;
};

export type SemanticNode =
  | TypeAliasNode
  | InterfaceNode
  | FunctionNode
  | ModelNode
  | ClassNode
  | BlockNode
  | ForNode
  | VarNode
  | DestructureNode
  | ReturnNode
  | ExprNode;

export type SemanticProgram = {
  body: SemanticNode[];
};

import type { ASTNode } from "../ast/index.js";

export type ParameterNode = {
  name: string;
  type: string;
  optional: boolean;
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
};

export type InterfaceFieldNode = {
  name: string;
  type: string;
  optional: boolean;
};

export type InterfaceNode = {
  kind: "Interface";
  name: string;
  typeParams: string[];
  parents: string[];
  fields: InterfaceFieldNode[];
  span: SourceSpan;
};

export type FunctionNode = {
  kind: "Function";
  name: string;
  typeParams: string[];
  params: ParameterNode[];
  returns: string;
  body: SemanticNode[];
  span: SourceSpan;
};

export type ModelNode = {
  kind: "Model";
  name: string;
  params: ParameterNode[];
  body: SemanticNode[];
  span: SourceSpan;
};

export type BlockNode = {
  kind: "Block";
  test?: ASTNode;
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
  | BlockNode
  | ForNode
  | VarNode
  | ReturnNode
  | ExprNode;

export type SemanticProgram = {
  body: SemanticNode[];
};

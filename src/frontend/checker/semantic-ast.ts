import type { ASTNode } from "../ast/index.js";

import type { ClassVisibility } from "../../core/class-visibility.js";
import type { ClassMemberKind } from "../../core/class-member.js";

export type { ClassMemberKind };

export type ParameterNode = {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
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

export type BlockTestRole = "guard" | "loop" | "subject" | "label";

export type BlockNode = {
  kind: "Block";
  test?: ASTNode;
  testRole?: BlockTestRole;
  otherwise?: ASTNode[];
  subject?: ASTNode;
  catchVariable?: string;
  catchVariableSpan?: SourceSpan;
  body: SemanticNode[];
  span: SourceSpan;
};

export type JumpVia = "throw" | "break" | "continue";

export type JumpNode = {
  kind: "Jump";
  via: JumpVia;
  value?: ASTNode;
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

export type ImportBindingNode = {
  imported: string;
  local: string;
  span: SourceSpan;
};

export type ImportNode = {
  kind: "Import";
  level: number;
  path: string[];
  alias: string | null;
  bindings: ImportBindingNode[];
  span: SourceSpan;
};

export type SemanticNode =
  | TypeAliasNode
  | InterfaceNode
  | FunctionNode
  | ModelNode
  | ClassNode
  | BlockNode
  | JumpNode
  | ForNode
  | VarNode
  | DestructureNode
  | ReturnNode
  | ExprNode
  | ImportNode;

export type SemanticProgram = {
  body: SemanticNode[];
};

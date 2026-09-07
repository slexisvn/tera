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
  generator: boolean;
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

const NO_ALTERNATIVE = 0;
const SEMANTIC_KIND = "kind";
const AST_KIND = "type";

export function branchChain(body: readonly SemanticNode[], at: number): BlockNode[] {
  const first = body[at];
  if (first?.kind !== "Block" || first.test === undefined) return [];
  if (first.testRole !== "guard" || (first.otherwise ?? []).length > NO_ALTERNATIVE) return [];
  const chain: BlockNode[] = [first];
  for (let next = at + 1; next < body.length; next++) {
    const node = body[next];
    if (node?.kind !== "Block" || (node.otherwise ?? []).length === NO_ALTERNATIVE) break;
    if (node.test !== undefined && node.testRole !== "guard") break;
    chain.push(node);
    if (node.test === undefined) break;
  }
  return chain;
}

const LEAVES_THE_BODY: ReadonlySet<SemanticNode["kind"]> = new Set<SemanticNode["kind"]>([
  "Return",
  "Jump",
]);

export function alwaysExits(body: readonly SemanticNode[]): boolean {
  return body.some((node) => LEAVES_THE_BODY.has(node.kind));
}

function gather(held: unknown, found: ASTNode[], within: boolean): void {
  if (held === null || typeof held !== "object") return;
  if (Array.isArray(held)) {
    for (const item of held) gather(item, found, within);
    return;
  }
  if (SEMANTIC_KIND in held) {
    if (within) for (const value of Object.values(held)) gather(value, found, within);
    return;
  }
  if (AST_KIND in held) {
    found.push(held as ASTNode);
    return;
  }
  for (const value of Object.values(held)) gather(value, found, within);
}

export function ownExpressions(node: SemanticNode): ASTNode[] {
  const found: ASTNode[] = [];
  for (const value of Object.values(node)) gather(value, found, false);
  return found;
}

export function nestedExpressions(held: SemanticNode | readonly SemanticNode[]): ASTNode[] {
  const found: ASTNode[] = [];
  gather(Array.isArray(held) ? held : [held], found, true);
  return found;
}

export const NodeType = {
  Program: "Program",
  FunctionDeclaration: "FunctionDeclaration",
  LazyFunctionDeclaration: "LazyFunctionDeclaration",
  LetDeclaration: "LetDeclaration",
  ConstDeclaration: "ConstDeclaration",
  VarDeclaration: "VarDeclaration",
  IfStatement: "IfStatement",
  WhileStatement: "WhileStatement",
  ForStatement: "ForStatement",
  ReturnStatement: "ReturnStatement",
  EmptyStatement: "EmptyStatement",
  BlockStatement: "BlockStatement",
  ExpressionStatement: "ExpressionStatement",
  AssignmentExpression: "AssignmentExpression",
  BinaryExpression: "BinaryExpression",
  UnaryExpression: "UnaryExpression",
  LogicalExpression: "LogicalExpression",
  CallExpression: "CallExpression",
  NamedArgument: "NamedArgument",
  NewExpression: "NewExpression",
  MemberExpression: "MemberExpression",
  ObjectExpression: "ObjectExpression",
  ArrayExpression: "ArrayExpression",
  ConditionalExpression: "ConditionalExpression",
  AwaitExpression: "AwaitExpression",
  SwitchStatement: "SwitchStatement",
  SwitchCase: "SwitchCase",
  BreakStatement: "BreakStatement",
  TryStatement: "TryStatement",
  ThrowStatement: "ThrowStatement",
  ClassDeclaration: "ClassDeclaration",
  ForInStatement: "ForInStatement",
  ForOfStatement: "ForOfStatement",
  Identifier: "Identifier",
  Literal: "Literal",
  ThisExpression: "ThisExpression",
  ObjectDestructuring: "ObjectDestructuring",
  ArrayDestructuring: "ArrayDestructuring",
  YieldExpression: "YieldExpression",
  UpdateExpression: "UpdateExpression",
  DoWhileStatement: "DoWhileStatement",
  ContinueStatement: "ContinueStatement",
  CompoundAssignmentExpression: "CompoundAssignmentExpression",
  ArrowFunctionExpression: "ArrowFunctionExpression",
  FunctionExpression: "FunctionExpression",
  TemplateLiteral: "TemplateLiteral",
  OptionalMemberExpression: "OptionalMemberExpression",
  OptionalCallExpression: "OptionalCallExpression",
  NullishCoalescingExpression: "NullishCoalescingExpression",
  SpreadElement: "SpreadElement",
  LabeledStatement: "LabeledStatement",
  SuperExpression: "SuperExpression",
  SuperCallExpression: "SuperCallExpression",
  SequenceExpression: "SequenceExpression",
  IndexExpression: "IndexExpression",
  IndexElement: "IndexElement",
} as const;

export type NodeTypeName = (typeof NodeType)[keyof typeof NodeType];
export type LiteralValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | { pattern: string; flags: string };
export type BindingTarget = string | ASTNode;
export type BindingIdentifier = {
  kind: "id";
  name: string;
  default?: ASTNode;
};
export type ObjectBindingPattern = {
  kind: "object";
  props: Array<{ key: string; value: BindingPattern }>;
  rest: string | null;
};
export type ArrayBindingPattern = {
  kind: "array";
  elements: Array<BindingPattern | null>;
  rest: BindingPattern | null;
};
export type BindingPattern =
  | string
  | BindingIdentifier
  | ObjectBindingPattern
  | ArrayBindingPattern
  | ObjectPropertyNode[]
  | BindingTarget[];
export type ParamNode =
  | BindingTarget
  | BindingIdentifier
  | { name: string; rest: true }
  | { name: string; default: ASTNode }
  | { pattern: BindingPattern; default?: ASTNode };
export type ObjectPropertyNode = {
  key?: string | ASTNode;
  value?: ASTNode;
  kind?: string;
  computed?: boolean;
  method?: boolean;
  shorthand?: boolean;
  argument?: ASTNode;
  spread?: boolean;
};
export type ClassMethodNode = {
  name: string | null;
  params?: BindingTarget[];
  body?: ASTNode[];
  func?: ASTNode;
  kind: string | null;
  static?: boolean;
};
export type CatchHandlerNode = {
  param: BindingTarget | null;
  body: ASTNode;
};
export type ASTFieldValue =
  | LiteralValue
  | NodeTypeName
  | ASTNode
  | ASTNode[]
  | Array<ASTNode | null>
  | BindingTarget[]
  | BindingIdentifier
  | BindingPattern
  | ParamNode[]
  | ObjectPropertyNode
  | ObjectPropertyNode[]
  | ClassMethodNode
  | ClassMethodNode[]
  | CatchHandlerNode;
export type ASTNode = {
  type: NodeTypeName;
  [key: string]: ASTFieldValue;
};
export type BindingKind = "let" | "const" | "var";

type AnyNode = ASTNode | null;
type Params = ParamNode[];

export function Program(body: ASTNode[]): ASTNode {
  return { type: NodeType.Program, body };
}

export function FunctionDeclaration(name: string | null, params: Params, body: ASTNode | ASTNode[]): ASTNode {
  return {
    type: NodeType.FunctionDeclaration,
    name,
    params,
    body,
    async: false,
  };
}

export function AsyncFunctionDeclaration(name: string | null, params: Params, body: ASTNode | ASTNode[]): ASTNode {
  return {
    type: NodeType.FunctionDeclaration,
    name,
    params,
    body,
    async: true,
  };
}

export function LazyFunctionDeclaration(
  name: string | null,
  params: Params,
  source: string,
  bodyStart: number,
  bodyEnd: number,
): ASTNode {
  return {
    type: NodeType.LazyFunctionDeclaration,
    name,
    params,
    source,
    bodyStart,
    bodyEnd,
    isLazy: true,
  };
}

export function LetDeclaration(name: BindingTarget | BindingIdentifier, init: AnyNode): ASTNode {
  return { type: NodeType.LetDeclaration, name, init };
}

export function ConstDeclaration(name: BindingTarget | BindingIdentifier, init: AnyNode): ASTNode {
  return { type: NodeType.ConstDeclaration, name, init };
}

export function VarDeclaration(name: BindingTarget | BindingIdentifier, init: AnyNode): ASTNode {
  return { type: NodeType.VarDeclaration, name, init };
}

export function IfStatement(test: AnyNode, consequent: ASTNode, alternate: AnyNode): ASTNode {
  return { type: NodeType.IfStatement, test, consequent, alternate };
}

export function WhileStatement(test: AnyNode, body: ASTNode): ASTNode {
  return { type: NodeType.WhileStatement, test, body };
}

export function ForStatement(init: BindingTarget | BindingIdentifier | ASTNode | ASTNode[] | null, test: AnyNode, update: AnyNode, body: ASTNode): ASTNode {
  return { type: NodeType.ForStatement, init, test, update, body };
}

export function ReturnStatement(argument: AnyNode): ASTNode {
  return { type: NodeType.ReturnStatement, argument };
}

export function EmptyStatement(): ASTNode {
  return { type: NodeType.EmptyStatement };
}

export function BlockStatement(body: ASTNode[]): ASTNode {
  return { type: NodeType.BlockStatement, body };
}

export function ExpressionStatement(expression: ASTNode): ASTNode {
  return { type: NodeType.ExpressionStatement, expression };
}

export function AssignmentExpression(target: ASTNode, value: ASTNode): ASTNode {
  return { type: NodeType.AssignmentExpression, target, value };
}

export function BinaryExpression(op: string, left: ASTNode, right: ASTNode): ASTNode {
  return { type: NodeType.BinaryExpression, op, left, right };
}

export function UnaryExpression(op: string, argument: ASTNode): ASTNode {
  return { type: NodeType.UnaryExpression, op, argument };
}

export function LogicalExpression(op: string, left: ASTNode, right: ASTNode): ASTNode {
  return { type: NodeType.LogicalExpression, op, left, right };
}

export function CallExpression(callee: ASTNode, args: ASTNode[]): ASTNode {
  return { type: NodeType.CallExpression, callee, args };
}

export function NamedArgument(name: string, value: ASTNode): ASTNode {
  return { type: NodeType.NamedArgument, name, value };
}

export function NewExpression(callee: ASTNode, args: ASTNode[]): ASTNode {
  return { type: NodeType.NewExpression, callee, args };
}

export function MemberExpression(object: ASTNode, property: string | ASTNode, computed?: boolean): ASTNode {
  return {
    type: NodeType.MemberExpression,
    object,
    property,
    computed: !!computed,
  };
}

export function IndexElementNode(
  kind: "index" | "slice",
  bounds: { value?: ASTNode; start?: ASTNode | null; stop?: ASTNode | null; step?: ASTNode | null },
): ASTNode {
  return { type: NodeType.IndexElement, kind, ...bounds };
}

export function IndexExpression(object: ASTNode, dims: ASTNode[]): ASTNode {
  return { type: NodeType.IndexExpression, object, dims };
}

export function ObjectExpression(properties: ObjectPropertyNode[]): ASTNode {
  return { type: NodeType.ObjectExpression, properties };
}

export function ArrayExpression(elements: Array<ASTNode | null>): ASTNode {
  return { type: NodeType.ArrayExpression, elements };
}

export function Identifier(name: string): ASTNode {
  return { type: NodeType.Identifier, name };
}

export function Literal(value: LiteralValue, kind?: string): ASTNode {
  return { type: NodeType.Literal, value, kind };
}

export function ConditionalExpression(test: ASTNode, consequent: ASTNode, alternate: ASTNode): ASTNode {
  return { type: NodeType.ConditionalExpression, test, consequent, alternate };
}

export function AwaitExpression(argument: ASTNode): ASTNode {
  return { type: NodeType.AwaitExpression, argument };
}

export function SequenceExpression(expressions: ASTNode[]): ASTNode {
  return { type: NodeType.SequenceExpression, expressions };
}

export function SwitchStatement(discriminant: ASTNode, cases: ASTNode[]): ASTNode {
  return { type: NodeType.SwitchStatement, discriminant, cases };
}

export function SwitchCase(test: AnyNode, consequent: ASTNode[]): ASTNode {
  return { type: NodeType.SwitchCase, test, consequent };
}

export function BreakStatement(): ASTNode {
  return { type: NodeType.BreakStatement };
}

export function TryStatement(block: ASTNode, handler: CatchHandlerNode | null, finalizer: AnyNode): ASTNode {
  return { type: NodeType.TryStatement, block, handler, finalizer };
}

export function ThrowStatement(argument: ASTNode): ASTNode {
  return { type: NodeType.ThrowStatement, argument };
}

export function ForInStatement(variable: BindingPattern, object: ASTNode, body: ASTNode, kind: BindingKind = "let"): ASTNode {
  return { type: NodeType.ForInStatement, variable, object, body, kind };
}

export function ForOfStatement(variable: BindingPattern, iterable: ASTNode, body: ASTNode, kind: BindingKind = "let"): ASTNode {
  return { type: NodeType.ForOfStatement, variable, iterable, body, kind };
}

export function ClassDeclaration(name: string | null, superClass: AnyNode, constructor: ASTNode | null, methods: ClassMethodNode[]): ASTNode {
  return {
    type: NodeType.ClassDeclaration,
    name,
    superClass,
    constructor,
    methods,
  };
}

export function SuperCallExpression(args: ASTNode[]): ASTNode {
  return { type: NodeType.SuperCallExpression, args };
}

export function SuperExpression(): ASTNode {
  return { type: NodeType.SuperExpression };
}

export function ThisExpression(): ASTNode {
  return { type: NodeType.ThisExpression };
}

export function ObjectDestructuring(pattern: BindingPattern, init: ASTNode, kind: BindingKind): ASTNode {
  return { type: NodeType.ObjectDestructuring, pattern, init, kind };
}

export function ArrayDestructuring(pattern: BindingPattern, init: ASTNode, kind: BindingKind): ASTNode {
  return { type: NodeType.ArrayDestructuring, pattern, init, kind };
}

export function GeneratorFunctionDeclaration(name: string | null, params: Params, body: ASTNode | ASTNode[]): ASTNode {
  return {
    type: NodeType.FunctionDeclaration,
    name,
    params,
    body,
    async: false,
    generator: true,
  };
}

export function YieldExpression(argument: AnyNode, delegate?: boolean): ASTNode {
  return { type: NodeType.YieldExpression, argument, delegate: !!delegate };
}

export function UpdateExpression(op: string, argument: ASTNode, prefix: boolean): ASTNode {
  return { type: NodeType.UpdateExpression, op, argument, prefix };
}

export function DoWhileStatement(test: ASTNode, body: ASTNode): ASTNode {
  return { type: NodeType.DoWhileStatement, test, body };
}

export function ContinueStatement(): ASTNode {
  return { type: NodeType.ContinueStatement };
}

export function CompoundAssignmentExpression(op: string, target: ASTNode, value: ASTNode): ASTNode {
  return { type: NodeType.CompoundAssignmentExpression, op, target, value };
}

export function ArrowFunctionExpression(params: Params, body: ASTNode | ASTNode[], isExpression: boolean): ASTNode {
  return { type: NodeType.ArrowFunctionExpression, params, body, isExpression };
}

export function FunctionExpression(name: string | null, params: Params, body: ASTNode | ASTNode[]): ASTNode {
  return { type: NodeType.FunctionExpression, name, params, body };
}

export function TemplateLiteral(parts: string[], expressions: ASTNode[]): ASTNode {
  return { type: NodeType.TemplateLiteral, parts, expressions };
}

export function OptionalMemberExpression(object: ASTNode, property: string | ASTNode, computed = false): ASTNode {
  return { type: NodeType.OptionalMemberExpression, object, property, computed };
}

export function OptionalCallExpression(callee: ASTNode, args: ASTNode[]): ASTNode {
  return { type: NodeType.OptionalCallExpression, callee, args };
}

export function NullishCoalescingExpression(left: ASTNode, right: ASTNode): ASTNode {
  return { type: NodeType.NullishCoalescingExpression, left, right };
}

export function SpreadElement(argument: ASTNode): ASTNode {
  return { type: NodeType.SpreadElement, argument };
}

export function LabeledStatement(label: string, body: ASTNode): ASTNode {
  return { type: NodeType.LabeledStatement, label, body };
}

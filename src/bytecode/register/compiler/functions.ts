import {
  AssignmentExpression,
  BlockStatement,
  CallExpression,
  ClassDeclaration,
  ExpressionStatement,
  FunctionDeclaration,
  Identifier,
  Literal,
  MemberExpression,
  NodeType,
  ReturnStatement,
  ThisExpression,
} from "../../../frontend/ast/index.js";
import type { ASTNode, ParamNode } from "../../../frontend/ast/index.js";
import { MODEL_MARKER, MODULE_METHODS } from "../../../frontend/model.js";
import { Scope } from "./helpers.js";
import type { ScopeResolution } from "./helpers.js";
import { TempAllocator } from "./temp-allocator.js";
import * as bytecode from "../ops/bytecode.js";
import { DEFAULT_CLASS_VISIBILITY, type ClassVisibility } from "../../../core/class-visibility.js";
import { runtimeInterfaceBaseName, type RuntimeInterfaceContract } from "../../../runtime/interface-contract.js";

type PatternNode = {
  kind: "id" | "array" | "object";
  name?: string;
  default?: ASTNode;
  elements?: Array<PatternNode | null>;
  rest?: PatternNode | string;
  props?: Array<{ key: string; value: PatternNode }>;
};

type FunctionBodyNode = ASTNode & {
  body?: ASTNode[];
};

type FunctionNode = ASTNode & {
  name: string | null;
  params: ParamNode[];
  body: FunctionBodyNode;
  async?: boolean;
  generator?: boolean;
  isExpression?: boolean;
  _superClassName?: string | null;
  source?: string;
  bodyStart?: number;
  bodyEnd?: number;
  visibility?: ClassVisibility;
  _classOwnerName?: string | null;
  _classConstructorVisibility?: ClassVisibility;
  _classInstanceMemberVisibility?: Record<string, ClassVisibility>;
  _classStaticMemberVisibility?: Record<string, ClassVisibility>;
  _classAbstract?: boolean;
  _classImplementedInterfaces?: string[];
  _classInstancePublicMembers?: bytecode.RuntimeNameMap;
  _classStaticPublicMembers?: bytecode.RuntimeNameMap;
};

type ClassMethodNode = {
  name: string;
  kind: "get" | "set" | string | null;
  static?: boolean;
  visibility?: ClassVisibility;
  abstract?: boolean;
  func: FunctionNode & { name: string; params: ParamNode[] };
};

type ClassFieldNode = {
  name: string;
  init?: ASTNode | null;
  static?: boolean;
  visibility?: ClassVisibility;
};

type ClassNode = ASTNode & {
  name: string;
  superClass?: { name: string } | null;
  constructor?: FunctionNode;
  methods: ClassMethodNode[];
  fields?: ClassFieldNode[];
  implements?: string[];
  abstract?: boolean;
};

type ModelFieldNode = {
  name: string;
  init: ASTNode;
  declaredType?: string;
};

type ModelSectionNode = {
  name: string;
  body: ASTNode;
};

type ModelNode = ASTNode & {
  name: string;
  params: ParamNode[];
  fields?: ModelFieldNode[];
  methods?: ClassMethodNode[];
  sections?: ModelSectionNode[];
};

type ForInNode = ASTNode & {
  variable: string | PatternNode;
  object: ASTNode;
  body: FunctionBodyNode;
  kind: "let" | "const" | "var";
};

type ForOfNode = ASTNode & {
  variable: string | PatternNode;
  iterable: ASTNode;
  body: FunctionBodyNode;
  kind: "let" | "const" | "var";
};

type DestructuringNode = ASTNode & {
  pattern: PatternNode;
  init: ASTNode;
  kind: "let" | "const" | "var";
};

type FunctionCompiledFunction = bytecode.RegisterCompiledFunction & {
  selfBindingSlot?: number;
  isArrow?: boolean;
};

function isPositionalParam(param: ParamNode): boolean {
  return typeof param === "string" || !paramRecord(param)?.rest;
}

function paramRecord(param: ParamNode): { rest?: boolean; name?: string; default?: ASTNode; pattern?: PatternNode } | null {
  return typeof param === "object" && param !== null ? param as { rest?: boolean; name?: string; default?: ASTNode; pattern?: PatternNode } : null;
}

function requireParamName(param: ParamNode, context: string): string {
  const name = paramRecord(param)?.name;
  if (!name) {
    throw new Error(`[RegCompiler] Missing parameter name for ${context}`);
  }
  return name;
}

function blockBodyStatements(body: FunctionBodyNode): ASTNode[] {
  return body.body ?? [];
}

function requireFunctionName(name: string | null, context: string): string {
  if (name === null) {
    throw new Error(`[RegCompiler] Missing function name for ${context}`);
  }
  return name;
}

function requirePatternName(pattern: PatternNode, context: string): string {
  if (!pattern.name) {
    throw new Error(`[RegCompiler] Missing pattern name for ${context}`);
  }
  return pattern.name;
}

function directBindingName(variable: string | PatternNode): string | null {
  if (typeof variable === "string") return variable;
  if (variable.kind === "id" && variable.name) return variable.name;
  return null;
}

function requirePatternRestPattern(rest: PatternNode | string, context: string): PatternNode {
  if (typeof rest === "string") {
    return { kind: "id", name: rest };
  }
  return rest;
}

function classVisibilityMap(node: ClassNode, staticMember: boolean): Record<string, ClassVisibility> {
  const out: Record<string, ClassVisibility> = {};
  for (const field of node.fields ?? []) {
    if (!!field.static === staticMember) out[field.name] = field.visibility ?? DEFAULT_CLASS_VISIBILITY;
  }
  for (const method of node.methods) {
    if (!!method.static === staticMember) out[method.name] = method.visibility ?? DEFAULT_CLASS_VISIBILITY;
  }
  return out;
}

function declaredInstanceFields(node: ClassNode): Set<string> {
  const out = new Set<string>();
  for (const field of node.fields ?? []) {
    if (!field.static) out.add(field.name);
  }
  return out;
}

function setPublicMember(out: bytecode.RuntimeNameMap, name: string, visibility: ClassVisibility | undefined): void {
  if ((visibility ?? DEFAULT_CLASS_VISIBILITY) === DEFAULT_CLASS_VISIBILITY) out[name] = true;
}

function classPublicMemberMap(node: ClassNode, staticMember: boolean): bytecode.RuntimeNameMap {
  const out: bytecode.RuntimeNameMap = {};
  for (const field of node.fields ?? []) {
    if (!!field.static === staticMember) setPublicMember(out, field.name, field.visibility);
  }
  for (const method of node.methods) {
    if (!!method.static === staticMember) setPublicMember(out, method.name, method.visibility);
  }
  if (!staticMember) {
    const declared = declaredInstanceFields(node);
    if (node.constructor) collectThisPublicAssignments(node.constructor.body, out, declared);
    for (const method of node.methods) {
      if (!method.static && !method.abstract) collectThisPublicAssignments(method.func.body, out, declared);
    }
  }
  return out;
}

function collectThisPublicAssignments(value: unknown, out: bytecode.RuntimeNameMap, declared: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectThisPublicAssignments(item, out, declared);
    return;
  }
  if (!value || typeof value !== "object" || !("type" in value)) return;
  const node = value as ASTNode;
  if (
    node.type === NodeType.FunctionDeclaration ||
    node.type === NodeType.LazyFunctionDeclaration ||
    node.type === NodeType.FunctionExpression ||
    node.type === NodeType.ArrowFunctionExpression ||
    node.type === NodeType.ClassDeclaration ||
    node.type === NodeType.ModelDeclaration
  ) {
    return;
  }
  const assigned = thisAssignedMember(node);
  if (assigned && !declared.has(assigned)) out[assigned] = true;
  for (const key of Object.keys(node)) {
    if (key === "type") continue;
    collectThisPublicAssignments(node[key], out, declared);
  }
}

function thisAssignedMember(node: ASTNode): string | null {
  if (node.type !== NodeType.AssignmentExpression) return null;
  const target = node.target as ASTNode | undefined;
  if (!target || target.type !== NodeType.MemberExpression || target.computed) return null;
  if ((target.object as ASTNode | undefined)?.type !== NodeType.ThisExpression) return null;
  return typeof target.property === "string" ? target.property : null;
}

function implementedContracts(node: ClassNode, contracts: Map<string, RuntimeInterfaceContract>): RuntimeInterfaceContract[] {
  const out: RuntimeInterfaceContract[] = [];
  for (const rawName of node.implements ?? []) {
    const name = runtimeInterfaceBaseName(rawName);
    const contract = contracts.get(name);
    if (!contract) throw new Error(`Cannot find interface '${rawName}' implemented by '${node.name}'`);
    out.push(contract);
  }
  return out;
}

function classAbstractMemberMap(node: ClassNode, inherited: Map<string, string>): Map<string, string> {
  const out = new Map(inherited);
  for (const field of node.fields ?? []) {
    if (!field.static) out.delete(field.name);
  }
  for (const method of node.methods) {
    if (method.static) continue;
    if (method.abstract) out.set(method.name, node.name);
    else out.delete(method.name);
  }
  return out;
}

function assertAbstractClassComplete(node: ClassNode, inherited: Map<string, string>): Map<string, string> {
  const ownAbstract = new Set<string>();
  for (const method of node.methods) {
    if (!method.abstract) continue;
    ownAbstract.add(method.name);
    if ((method.visibility ?? DEFAULT_CLASS_VISIBILITY) === "private") {
      throw new Error(`Abstract member '${method.name}' cannot be private`);
    }
    if (method.static) {
      throw new Error(`Static member '${method.name}' cannot be abstract`);
    }
  }
  const unresolved = classAbstractMemberMap(node, inherited);
  if (!node.abstract) {
    const first = unresolved.entries().next().value as [string, string] | undefined;
    if (first) {
      const [name, owner] = first;
      if (ownAbstract.has(name)) {
        throw new Error(`Class '${node.name}' must be abstract because it declares abstract member '${name}'`);
      }
      throw new Error(`Class '${node.name}' must implement abstract member '${name}' inherited from '${owner}'`);
    }
  }
  return unresolved;
}

function fieldAssignmentTarget(field: ClassFieldNode): ASTNode {
  return {
    type: NodeType.MemberExpression,
    object: { type: NodeType.ThisExpression },
    property: field.name,
    computed: false,
  };
}

function fieldInitializer(field: ClassFieldNode): ASTNode {
  return field.init ?? { type: NodeType.Literal, value: undefined, kind: "undefined" };
}

function fieldAssignment(field: ClassFieldNode): ASTNode {
  return {
    type: NodeType.ExpressionStatement,
    expression: {
      type: NodeType.AssignmentExpression,
      target: fieldAssignmentTarget(field),
      value: fieldInitializer(field),
    },
  };
}

function injectInstanceFields(ctorNode: FunctionNode, node: ClassNode): FunctionNode {
  const fields = (node.fields ?? []).filter((field) => !field.static);
  if (!fields.length || ctorNode.body.type !== NodeType.BlockStatement) return ctorNode;
  const assignments = fields.map(fieldAssignment);
  const body = blockBodyStatements(ctorNode.body);
  let insertAt = 0;
  if (node.superClass) {
    const superIndex = body.findIndex((stmt) => {
      const expression = stmt.type === NodeType.ExpressionStatement ? stmt.expression as ASTNode : null;
      return expression?.type === NodeType.SuperCallExpression;
    });
    insertAt = superIndex >= 0 ? superIndex + 1 : 0;
  }
  return {
    ...ctorNode,
    body: {
      ...ctorNode.body,
      body: [...body.slice(0, insertAt), ...assignments, ...body.slice(insertAt)],
    },
  } as FunctionNode;
}

function lowerModelDeclaration(node: ModelNode): ClassNode {
  const fields = node.fields ?? [];
  const methodNames = new Set<string>();
  const fieldNames = () => new Set(fields.map((field) => field.name));
  const methods: ClassMethodNode[] = (node.methods ?? []).map((method) => {
    methodNames.add(method.name);
    return {
      ...method,
      kind: method.kind ?? null,
      func: {
        ...method.func,
        body: rewriteModelFieldRefs(method.func.body, fieldNames, node.name),
      },
    };
  });
  for (const section of node.sections ?? []) {
    methodNames.add(section.name);
    methods.push({
      name: section.name,
      kind: null,
      func: FunctionDeclaration(section.name, [], rewriteModelFieldRefs(section.body, fieldNames, node.name)) as FunctionNode & { name: string; params: ParamNode[] },
    });
  }
  for (const name of MODULE_METHODS) {
    if (methodNames.has(name)) continue;
    methods.push({
      name,
      kind: null,
      func: FunctionDeclaration(name, ["args"], BlockStatement([
        ReturnStatement(CallExpression(Identifier("model_native"), [
          ThisExpression(),
          Literal(name, "string"),
          Identifier("args"),
        ])),
      ])) as FunctionNode & { name: string; params: ParamNode[] },
    });
  }
  const ctorBody = [
    ExpressionStatement(
      AssignmentExpression(
        MemberExpression(ThisExpression(), MODEL_MARKER, false),
        Literal(node.name, "string"),
      ),
    ),
    ...fields.map((field) =>
      ExpressionStatement(
        AssignmentExpression(
          MemberExpression(ThisExpression(), field.name, false),
          field.init,
        ),
      ),
    ),
  ];
  const constructorNode = FunctionDeclaration("constructor", node.params, BlockStatement(ctorBody)) as FunctionNode;
  return ClassDeclaration(node.name, null, constructorNode, methods, []) as ClassNode;
}

function rewriteModelFieldRefs(node: ASTNode, fieldNames: () => Set<string>, modelName?: string): ASTNode {
  const fields = fieldNames();
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object" || !("type" in value)) return value;
    const current = value as ASTNode;
    if (current.type === NodeType.Identifier && typeof current.name === "string") {
      if (modelName && current.name === modelName) return ThisExpression();
      if (fields.has(current.name)) return MemberExpression(ThisExpression(), current.name, false);
    }
    const next: ASTNode = { ...current };
    for (const key of Object.keys(next)) {
      if (key === "type") continue;
      next[key] = visit(next[key]) as never;
    }
    return next;
  };
  return visit(node) as ASTNode;
}

type FunctionCompilerThis = {
  func: bytecode.RegisterCompiledFunction;
  scope: Scope;
  temps: TempAllocator;
  _currentSuperClassName?: string | null;
  _nextFunctionIsClassConstructor?: boolean;
  interfaceContracts: Map<string, RuntimeInterfaceContract>;
  classAbstractMembers: Map<string, Map<string, string>>;
  _breakJumps: number[];
  _continueJumps: number[];
  _compileParams(
    params: ParamNode[],
    innerFunc: bytecode.RegisterCompiledFunction,
    innerScope: Scope,
  ): void;
  compileExpression(node: ASTNode): void;
  compileStatement(node: ASTNode): void;
  compileStatements(nodes: ASTNode[]): void;
  compileFunctionDeclaration(node: FunctionNode): void;
  compileFunctionExpression(node: FunctionNode): void;
  compileArrowFunction(node: FunctionNode): void;
  compileLazyFunctionDeclaration(node: FunctionNode): void;
  compileClassDeclaration(node: ClassNode): void;
  compileModelDeclaration(node: ModelNode): void;
  compileSuperCall(node: ASTNode & { args: ASTNode[] }): void;
  compileForInStatement(node: ForInNode): void;
  compileForOfStatement(node: ForOfNode): void;
  compileObjectDestructuring(node: DestructuringNode): void;
  compileArrayDestructuring(node: DestructuringNode): void;
  _patternSlot(name: string, kind: "let" | "const" | "var"): number;
  _applyPatternDefault(target: PatternNode, srcReg: number): number;
  _destructureTarget(
    target: PatternNode | string,
    srcReg: number,
    kind: "let" | "const" | "var",
  ): void;
  _prepareFunctionBody(nodes?: ASTNode[]): void;
  _prescanStatement(node: ASTNode): void;
  _declareLocal(name: string, kind: "let" | "const" | "var" | "class"): number;
  _bodyMayCapture(node: ASTNode): boolean;
  emitLoadToAcc(resolved: ScopeResolution): void;
  emitStoreAcc(resolved: ScopeResolution): void;
};

type FunctionMethodMap = {
  _compileParams(
    this: FunctionCompilerThis,
    params: ParamNode[],
    innerFunc: bytecode.RegisterCompiledFunction,
    innerScope: Scope,
  ): void;
  compileFunctionDeclaration(this: FunctionCompilerThis, node: FunctionNode): void;
  compileFunctionExpression(this: FunctionCompilerThis, node: FunctionNode): void;
  compileArrowFunction(this: FunctionCompilerThis, node: FunctionNode): void;
  compileLazyFunctionDeclaration(this: FunctionCompilerThis, node: FunctionNode): void;
  compileClassDeclaration(this: FunctionCompilerThis, node: ClassNode): void;
  compileModelDeclaration(this: FunctionCompilerThis, node: ModelNode): void;
  compileSuperCall(this: FunctionCompilerThis, node: ASTNode & { args: ASTNode[] }): void;
  compileForInStatement(this: FunctionCompilerThis, node: ForInNode): void;
  compileForOfStatement(this: FunctionCompilerThis, node: ForOfNode): void;
  compileObjectDestructuring(this: FunctionCompilerThis, node: DestructuringNode): void;
  compileArrayDestructuring(this: FunctionCompilerThis, node: DestructuringNode): void;
  _patternSlot(this: FunctionCompilerThis, name: string, kind: "let" | "const" | "var"): number;
  _applyPatternDefault(this: FunctionCompilerThis, target: PatternNode, srcReg: number): number;
  _destructureTarget(
    this: FunctionCompilerThis,
    target: PatternNode | string,
    srcReg: number,
    kind: "let" | "const" | "var",
  ): void;
} & ThisType<FunctionCompilerThis>;

export const functionMethods: FunctionMethodMap = {
  _compileParams(params, innerFunc, innerScope) {
    const slots: number[] = [];
    const paramNames: string[] = [];
    let positionalIndex = 0;
    for (const param of params) {
      const record = paramRecord(param);
      if (typeof param === "string") {
        const slot = innerFunc.addLocal(param);
        innerScope.define(param, slot);
        slots.push(slot);
        paramNames.push(param);
        positionalIndex++;
      } else if (record?.rest) {
        const name = requireParamName(param, "rest parameter");
        const slot = innerFunc.addLocal(name);
        innerScope.define(name, slot);
        slots.push(slot);
      } else if (record?.pattern) {
        slots.push(innerFunc.addLocal("_param$" + positionalIndex));
        paramNames.push("_param$" + positionalIndex);
        positionalIndex++;
      } else if (record?.default) {
        const name = requireParamName(param, "default parameter");
        const slot = innerFunc.addLocal(name);
        innerScope.define(name, slot);
        slots.push(slot);
        paramNames.push(name);
        positionalIndex++;
      }
    }
    innerFunc.paramNames = paramNames;

    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const record = paramRecord(param);
      const slot = slots[i]!;
      if (typeof param === "string") {
        continue;
      } else if (record?.rest) {
        const normalCount = params.filter(
          (p) => isPositionalParam(p),
        ).length;
        innerFunc.emit(bytecode.ROP_REST_ARGS, normalCount);
        innerFunc.emit(bytecode.ROP_STAR, slot);
      } else if (record?.default) {
        innerFunc.emit(bytecode.ROP_LDA_REG, slot);
        innerFunc.emit(bytecode.ROP_IS_NULLISH);
        const jumpPastDefault = innerFunc.emit(bytecode.ROP_JUMP_IF_FALSE, 0);
        this.compileExpression(record.default);
        innerFunc.emit(bytecode.ROP_STAR, slot);
        innerFunc.patchJump(jumpPastDefault, innerFunc.instructions.length);
      }
      if (record?.pattern) {
        this._destructureTarget(record.pattern, slot, "let");
      }
    }
  },

  compileFunctionDeclaration(node) {
    const outerFunc = this.func;
    const outerScope = this.scope;
    const outerTemps = this.temps;
    const outerSuperClassName = this._currentSuperClassName;

    const paramCount = node.params.filter(
      (p) => isPositionalParam(p),
    ).length;
    const functionName = requireFunctionName(node.name, "declaration");
    const innerFunc = new bytecode.RegisterCompiledFunction(
      functionName,
      paramCount,
    );
    innerFunc.classOwnerName = node._classOwnerName ?? null;
    innerFunc.classConstructorVisibility = node._classConstructorVisibility;
    innerFunc.classInstanceMemberVisibility = node._classInstanceMemberVisibility;
    innerFunc.classStaticMemberVisibility = node._classStaticMemberVisibility;
    innerFunc.classAbstract = node._classAbstract;
    innerFunc.classImplementedInterfaces = node._classImplementedInterfaces;
    innerFunc.classInstancePublicMembers = node._classInstancePublicMembers;
    innerFunc.classStaticPublicMembers = node._classStaticPublicMembers;
    innerFunc.isAsync = !!node.async;
    innerFunc.explicitAsync = !!node.explicitAsync;
    innerFunc.isGenerator = !!node.generator;
    if (this._nextFunctionIsClassConstructor) {
      innerFunc.isClassConstructor = true;
      this._nextFunctionIsClassConstructor = false;
    }
    const innerScope = new Scope(outerScope);
    innerScope.isFunctionBoundary = true;

    this.func = innerFunc;
    this.scope = innerScope;
    this.temps = new TempAllocator(innerFunc);
    this._currentSuperClassName = node._superClassName || null;

    this._compileParams(node.params, innerFunc, innerScope);

    if (node.body.type === NodeType.BlockStatement) {
      const statements = blockBodyStatements(node.body);
      this._prepareFunctionBody(statements);
      this.compileStatements(statements);
    } else {
      this._prescanStatement(node.body);
      this.compileStatement(node.body);
    }

    const lastInstr = innerFunc.instructions[innerFunc.instructions.length - 1];
    if (!lastInstr || lastInstr.opcode !== bytecode.ROP_RETURN) {
      innerFunc.emit(bytecode.ROP_LDA_UNDEFINED);
      innerFunc.emit(bytecode.ROP_RETURN);
    }

    innerFunc.upvalues = innerScope.upvalues;

    this.func = outerFunc;
    this.scope = outerScope;
    this.temps = outerTemps;
    this._currentSuperClassName = outerSuperClassName;

    const constIdx = outerFunc.addConstant(innerFunc);

    if (innerFunc.upvalues.length > 0) {
      outerFunc.emit(bytecode.ROP_MAKE_CLOSURE, constIdx);
    } else {
      outerFunc.emit(bytecode.ROP_LDA_CONST, constIdx);
    }

    const resolved = this.scope.resolve(functionName);
    if (resolved !== null) {
      this.emitStoreAcc(resolved);
    } else {
      const nameIdx = outerFunc.addConstant(functionName);
      outerFunc.emit(bytecode.ROP_STA_GLOBAL, nameIdx);
    }
  },

  compileFunctionExpression(node) {
    const outerFunc = this.func;
    const outerScope = this.scope;
    const outerTemps = this.temps;

    const name = node.name || "<anonymous>";
    const paramCount = node.params.filter(
      (p) => isPositionalParam(p),
    ).length;
    const innerFunc: FunctionCompiledFunction = new bytecode.RegisterCompiledFunction(name, paramCount);
    innerFunc.isAsync = !!node.async;
    innerFunc.explicitAsync = !!node.explicitAsync;
    innerFunc.isGenerator = !!node.generator;
    const innerScope = new Scope(outerScope);
    innerScope.isFunctionBoundary = true;

    this.func = innerFunc;
    this.scope = innerScope;
    this.temps = new TempAllocator(innerFunc);

    this._compileParams(node.params, innerFunc, innerScope);

    if (node.name) {
      const selfSlot = innerFunc.addLocal(node.name);
      innerScope.define(node.name, selfSlot);
      innerFunc.selfBindingSlot = selfSlot;
    }

    if (node.body.type === NodeType.BlockStatement) {
      const statements = blockBodyStatements(node.body);
      this._prepareFunctionBody(statements);
      this.compileStatements(statements);
    } else {
      this.compileStatement(node.body);
    }

    const lastInstr = innerFunc.instructions[innerFunc.instructions.length - 1];
    if (!lastInstr || lastInstr.opcode !== bytecode.ROP_RETURN) {
      innerFunc.emit(bytecode.ROP_LDA_UNDEFINED);
      innerFunc.emit(bytecode.ROP_RETURN);
    }

    innerFunc.upvalues = innerScope.upvalues;
    this.func = outerFunc;
    this.scope = outerScope;
    this.temps = outerTemps;

    const constIdx = outerFunc.addConstant(innerFunc);
    if (innerFunc.upvalues.length > 0) {
      outerFunc.emit(bytecode.ROP_MAKE_CLOSURE, constIdx);
    } else {
      outerFunc.emit(bytecode.ROP_LDA_CONST, constIdx);
    }
  },

  compileArrowFunction(node) {
    const outerFunc = this.func;
    const outerScope = this.scope;
    const outerTemps = this.temps;

    const paramCount = node.params.filter(
      (p) => isPositionalParam(p),
    ).length;
    const innerFunc: FunctionCompiledFunction = new bytecode.RegisterCompiledFunction(
      "<arrow>",
      paramCount,
    );
    innerFunc.isArrow = true;
    innerFunc.isAsync = !!node.async;
    innerFunc.explicitAsync = !!node.explicitAsync;
    const innerScope = new Scope(outerScope);
    innerScope.isFunctionBoundary = true;

    this.func = innerFunc;
    this.scope = innerScope;
    this.temps = new TempAllocator(innerFunc);

    this._compileParams(node.params, innerFunc, innerScope);

    if (node.isExpression) {
      this.compileExpression(node.body);
      innerFunc.emit(bytecode.ROP_RETURN);
    } else {
      if (node.body.type === NodeType.BlockStatement) {
        const statements = blockBodyStatements(node.body);
        this._prepareFunctionBody(statements);
        this.compileStatements(statements);
      } else {
        this.compileStatement(node.body);
      }
      const lastInstr =
        innerFunc.instructions[innerFunc.instructions.length - 1];
      if (!lastInstr || lastInstr.opcode !== bytecode.ROP_RETURN) {
        innerFunc.emit(bytecode.ROP_LDA_UNDEFINED);
        innerFunc.emit(bytecode.ROP_RETURN);
      }
    }

    innerFunc.upvalues = innerScope.upvalues;
    this.func = outerFunc;
    this.scope = outerScope;
    this.temps = outerTemps;

    const constIdx = outerFunc.addConstant(innerFunc);
    if (innerFunc.upvalues.length > 0) {
      outerFunc.emit(bytecode.ROP_MAKE_CLOSURE, constIdx);
    } else {
      outerFunc.emit(bytecode.ROP_LDA_CONST, constIdx);
    }
  },

  compileLazyFunctionDeclaration(node) {
    const functionName = requireFunctionName(node.name, "lazy declaration");
    const innerFunc = new bytecode.RegisterCompiledFunction(
      functionName,
      node.params.length,
    );
    innerFunc.isLazy = true;
    innerFunc.isAsync = !!node.async;
    innerFunc.explicitAsync = !!node.explicitAsync;
    innerFunc.lazySource = node.source ?? null;
    innerFunc.lazyBodyStart = node.bodyStart ?? 0;
    innerFunc.lazyBodyEnd = node.bodyEnd ?? 0;
    innerFunc.lazyParams = node.params;

    innerFunc.emit(bytecode.ROP_LDA_UNDEFINED);
    innerFunc.emit(bytecode.ROP_RETURN);

    const constIdx = this.func.addConstant(innerFunc);
    this.func.emit(bytecode.ROP_LDA_CONST, constIdx);

    const resolved = this.scope.resolve(functionName);
    if (resolved !== null) {
      this.emitStoreAcc(resolved);
    } else {
      const nameIdx = this.func.addConstant(functionName);
      this.func.emit(bytecode.ROP_STA_GLOBAL, nameIdx);
    }
  },

  compileModelDeclaration(node) {
    this.compileClassDeclaration(lowerModelDeclaration(node));
  },

  compileClassDeclaration(node) {
    const inheritedAbstract = node.superClass
      ? this.classAbstractMembers.get(node.superClass.name) ?? new Map()
      : new Map();
    const unresolvedAbstract = assertAbstractClassComplete(node, inheritedAbstract);
    const contracts = implementedContracts(node, this.interfaceContracts);
    let superClassReg = -1;
    if (node.superClass) {
      const superName = node.superClass.name;
      superClassReg = this.func.addLocal("_superClass$" + node.name);
      this.temps.freeTemps = this.temps.freeTemps.filter(
        (r: number) => r !== superClassReg,
      );
      this.scope.define("_superClass$" + node.name, superClassReg);
      const nameIdx = this.func.addConstant(superName);
      const resolved = this.scope.resolve(superName);
      if (resolved && resolved.type === "local") {
        this.func.emit(bytecode.ROP_LDA_REG, resolved.slot);
      } else {
        this.func.emit(bytecode.ROP_LDA_GLOBAL, nameIdx);
      }
      this.func.emit(bytecode.ROP_STAR, superClassReg);
    }

    const ctorNodeSource: FunctionNode = node.constructor || (node.superClass ? {
      type: NodeType.FunctionDeclaration,
      name: node.name,
      params: [{ name: "args", rest: true }],
      body: {
        type: NodeType.BlockStatement,
        body: [{
          type: NodeType.ExpressionStatement,
          expression: {
            type: NodeType.SuperCallExpression,
            args: [{ type: NodeType.SpreadElement, argument: { type: NodeType.Identifier, name: "args" } }],
          },
        }],
      },
    } : {
      type: NodeType.FunctionDeclaration,
      name: node.name,
      params: [],
      body: { type: NodeType.BlockStatement, body: [] },
    });
    const ctorNode = injectInstanceFields(ctorNodeSource, node);
    ctorNode.name = node.name;
    ctorNode._superClassName = node.superClass ? node.name : null;
    ctorNode._classOwnerName = node.name;
    ctorNode._classConstructorVisibility = ctorNode.visibility ?? DEFAULT_CLASS_VISIBILITY;
    ctorNode._classInstanceMemberVisibility = classVisibilityMap(node, false);
    ctorNode._classStaticMemberVisibility = classVisibilityMap(node, true);
    ctorNode._classAbstract = !!node.abstract;
    ctorNode._classImplementedInterfaces = (node.implements ?? []).map(runtimeInterfaceBaseName);
    ctorNode._classInstancePublicMembers = classPublicMemberMap(node, false);
    ctorNode._classStaticPublicMembers = classPublicMemberMap(node, true);
    this._nextFunctionIsClassConstructor = true;
    this.compileFunctionDeclaration(ctorNode);

    const loadClassValue = (): void => {
      const resolved = this.scope.resolve(node.name);
      if (resolved && resolved.type === "local") {
        this.func.emit(bytecode.ROP_LDA_REG, resolved.slot);
      } else {
        this.func.emit(bytecode.ROP_LDA_GLOBAL, this.func.addConstant(node.name));
      }
    };

    const prototypeNameIdx = this.func.addConstant("prototype");
    loadClassValue();
    const classReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, classReg);
    this.func.emit(bytecode.ROP_LDA_PROP, classReg, prototypeNameIdx, this.func.allocFeedbackSlot());
    const prototypeReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, prototypeReg);

    if (node.superClass) {
      this.func.emit(bytecode.ROP_LDA_REG, superClassReg);
      const superCtorReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, superCtorReg);
      this.func.emit(bytecode.ROP_LDA_PROP, superCtorReg, prototypeNameIdx, this.func.allocFeedbackSlot());
      const superProtoReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, superProtoReg);
      this.func.emit(bytecode.ROP_SET_PROTO, prototypeReg, superProtoReg);
      this.func.emit(bytecode.ROP_SET_PROTO, classReg, superCtorReg);
      this.temps.free(superProtoReg);
      this.temps.free(superCtorReg);
    }

    for (const method of node.methods) {
      if (method.abstract) continue;
      const targetReg = method.static ? classReg : prototypeReg;

      const outerFunc = this.func;
      const outerScope = this.scope;
      const outerTemps = this.temps;
      const outerSuperClassName = this._currentSuperClassName;

      const methodFunc = new bytecode.RegisterCompiledFunction(
        method.func.name,
        method.func.params.filter((p: ParamNode) => isPositionalParam(p)).length,
      );
      methodFunc.classOwnerName = node.name;
      this.func = methodFunc;
      this.scope = new Scope(outerScope);
      this.scope.isFunctionBoundary = true;
      this.temps = new TempAllocator(methodFunc);
      this._currentSuperClassName = method.static ? null : (node.superClass ? node.name : null);

      this._compileParams(method.func.params, methodFunc, this.scope);

      if (method.func.body.type === NodeType.BlockStatement) {
        const statements = blockBodyStatements(method.func.body);
        this._prepareFunctionBody(statements);
        this.compileStatements(statements);
      } else {
        this.compileStatement(method.func.body);
      }

      if (
        methodFunc.instructions.length === 0 ||
        methodFunc.instructions[methodFunc.instructions.length - 1].opcode !==
          bytecode.ROP_RETURN
      ) {
        methodFunc.emit(bytecode.ROP_LDA_UNDEFINED);
        methodFunc.emit(bytecode.ROP_RETURN);
      }

      methodFunc.upvalues = this.scope.upvalues;

      this.func = outerFunc;
      this.scope = outerScope;
      this.temps = outerTemps;
      this._currentSuperClassName = outerSuperClassName;

      const constIdx = outerFunc.addConstant(methodFunc);
      outerFunc.emit(methodFunc.upvalues.length > 0 ? bytecode.ROP_MAKE_CLOSURE : bytecode.ROP_LDA_CONST, constIdx);

      const methodNameIdx = outerFunc.addConstant(method.name);
      if (method.kind === "get" || method.kind === "set") {
        const fnReg = this.temps.alloc();
        outerFunc.emit(bytecode.ROP_STAR, fnReg);
        const getterReg = method.kind === "get" ? fnReg : -1;
        const setterReg = method.kind === "set" ? fnReg : -1;
        outerFunc.emit(bytecode.ROP_DEFINE_ACCESSOR, targetReg, methodNameIdx, getterReg, setterReg);
        this.temps.free(fnReg);
      } else {
        outerFunc.emit(bytecode.ROP_DEFINE_CLASS_MEMBER, targetReg, methodNameIdx, outerFunc.allocFeedbackSlot());
      }
    }

    for (const field of node.fields ?? []) {
      if (!field.static) continue;
      const outerFunc = this.func;
      const outerScope = this.scope;
      const outerTemps = this.temps;
      const outerSuperClassName = this._currentSuperClassName;
      const initializerFunc = new bytecode.RegisterCompiledFunction(`${node.name}.${field.name}$init`, 0);
      initializerFunc.classOwnerName = node.name;
      this.func = initializerFunc;
      this.scope = new Scope(outerScope);
      this.scope.isFunctionBoundary = true;
      this.temps = new TempAllocator(initializerFunc);
      this._currentSuperClassName = null;
      this.compileExpression(fieldInitializer(field));
      initializerFunc.emit(bytecode.ROP_RETURN);
      initializerFunc.upvalues = this.scope.upvalues;
      this.func = outerFunc;
      this.scope = outerScope;
      this.temps = outerTemps;
      this._currentSuperClassName = outerSuperClassName;
      const initIdx = this.func.addConstant(initializerFunc);
      this.func.emit(initializerFunc.upvalues.length > 0 ? bytecode.ROP_MAKE_CLOSURE : bytecode.ROP_LDA_CONST, initIdx);
      const initReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, initReg);
      this.func.emit(bytecode.ROP_CALL, initReg, 0, 0, this.func.allocFeedbackSlot());
      this.temps.free(initReg);
      const fieldNameIdx = this.func.addConstant(field.name);
      this.func.emit(bytecode.ROP_DEFINE_CLASS_MEMBER, classReg, fieldNameIdx, this.func.allocFeedbackSlot());
    }

    if (contracts.length) {
      const contractsIdx = this.func.addConstant(contracts);
      this.func.emit(bytecode.ROP_ASSERT_CLASS_CONTRACTS, classReg, contractsIdx);
    }
    this.classAbstractMembers.set(node.name, unresolvedAbstract);
    this.temps.free(prototypeReg);
    this.temps.free(classReg);
  },

  compileSuperCall(node) {
    const className = this._currentSuperClassName;
    if (!className) {
      throw new Error(
        "[RegCompiler] super() called outside of a class constructor",
      );
    }
    const superVar = "_superClass$" + className;
    const resolved = this.scope.resolve(superVar);
    if (!resolved) {
      throw new Error("[RegCompiler] Cannot resolve super class reference");
    }
    this.emitLoadToAcc(resolved);
    const superReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, superReg);

    if (node.args.length === 1 && node.args[0]?.type === NodeType.SpreadElement) {
      const spreadArg = node.args[0].argument as ASTNode | undefined;
      if (!spreadArg) throw new Error("[RegCompiler] Missing spread argument for super()");
      this.compileExpression(spreadArg);
      const argsReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, argsReg);
      this.func.emit(bytecode.ROP_LDA_THIS);
      const thisReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, thisReg);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_CALL_SPREAD, superReg, argsReg, thisReg, fbSlot);
      this.temps.free(thisReg);
      this.temps.free(argsReg);
      this.temps.free(superReg);
      return;
    }

    const positionalArgs = node.args.filter((arg) => arg.type !== NodeType.NamedArgument);
    const namedArgs = node.args.filter((arg) => arg.type === NodeType.NamedArgument);
    const firstArgReg = positionalArgs.length > 0 ? this.temps.allocContiguous(positionalArgs.length) : 0;
    for (let i = 0; i < positionalArgs.length; i++) {
      this.compileExpression(positionalArgs[i]);
      this.func.emit(bytecode.ROP_STAR, firstArgReg + i);
    }

    let firstNamedReg = 0;
    if (namedArgs.length > 0) firstNamedReg = this.temps.allocContiguous(namedArgs.length);
    for (let i = 0; i < namedArgs.length; i++) {
      const value = namedArgs[i].value as ASTNode | undefined;
      if (!value) throw new Error("[RegCompiler] Missing named argument value for super()");
      this.compileExpression(value);
      this.func.emit(bytecode.ROP_STAR, firstNamedReg + i);
    }

    this.func.emit(bytecode.ROP_LDA_THIS);
    const thisReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, thisReg);

    this.func.emit(bytecode.ROP_LDA_REG, superReg);
    const fbSlot = this.func.allocFeedbackSlot();
    if (namedArgs.length > 0) {
      const namesIdx = this.func.addConstant(namedArgs.map((arg) => String(arg.name)));
      this.func.emit(
        bytecode.ROP_CALL_METHOD_NAMED,
        thisReg,
        firstArgReg,
        positionalArgs.length,
        firstNamedReg,
        namesIdx,
        namedArgs.length,
        fbSlot,
      );
    } else {
      this.func.emit(
        bytecode.ROP_CALL_METHOD,
        thisReg,
        firstArgReg,
        positionalArgs.length,
        fbSlot,
      );
    }

    for (let i = namedArgs.length - 1; i >= 0; i--) this.temps.free(firstNamedReg + i);
    if (positionalArgs.length > 0) for (let i = positionalArgs.length - 1; i >= 0; i--) this.temps.free(firstArgReg + i);
    this.temps.free(thisReg);
    this.temps.free(superReg);
  },

  compileForInStatement(node) {
    const objReg = this.temps.alloc();
    this.compileExpression(node.object);
    this.func.emit(bytecode.ROP_STAR, objReg);

    const keysSlot = this.func.addLocal("_keys$");
    this.func.emit(bytecode.ROP_GET_KEYS, objReg);
    this.func.emit(bytecode.ROP_STAR, keysSlot);

    const iSlot = this.func.addLocal("_i$");
    const zeroIdx = this.func.addConstant(0);
    this.func.emit(bytecode.ROP_LDA_CONST, zeroIdx);
    this.func.emit(bytecode.ROP_STAR, iSlot);

    const lenSlot = this.func.addLocal("_len$");
    this.func.emit(bytecode.ROP_GET_LENGTH, keysSlot);
    this.func.emit(bytecode.ROP_STAR, lenSlot);

    this.temps.free(objReg);

    const outerScope = this.scope;
    this.scope = new Scope(outerScope);
    const variable = node.variable;
    const variableName = directBindingName(variable);
    const isPattern = variableName === null;
    const isScriptVar = !isPattern && outerScope.isInScriptScope() && node.kind === "var";
    let varSlot = null;
    let varGlobalNameIdx = null;
    let patternSlot: number | null = null;
    if (isPattern) {
      patternSlot = this.func.addLocal("_forInKey$");
    } else if (isScriptVar) {
      varGlobalNameIdx = this.func.addConstant(variableName);
    } else if (node.kind === "var") {
      const varResolved = outerScope.resolve(variableName);
      varSlot = varResolved
        ? varResolved.slot
        : this._declareLocal(variableName, "var");
      if (!varResolved) this.func.setLocalBindingKind(varSlot, "var");
    } else {
      const kind = node.kind === "const" ? "const" : "let";
      varSlot = this._declareLocal(variableName, kind);
      this.func.setLocalBindingKind(varSlot, kind);
    }

    const outerBreak = this._breakJumps;
    const outerContinue = this._continueJumps;
    const breakJumps: number[] = [];
    const continueJumps: number[] = [];
    this._breakJumps = breakJumps;
    this._continueJumps = continueJumps;

    const loopStart = this.func.instructions.length;
    this.func.emit(bytecode.ROP_LDA_REG, iSlot);
    const fbSlot = this.func.allocFeedbackSlot();
    this.func.emit(bytecode.ROP_LT, lenSlot, fbSlot);
    const exitJump = this.func.emit(bytecode.ROP_JUMP_IF_FALSE, 0);

    this.func.emit(bytecode.ROP_LDA_INDEX, keysSlot, iSlot);
    if (isPattern) {
      this.func.emit(bytecode.ROP_STAR, patternSlot!);
      const kind = node.kind === "const" ? "const" : node.kind === "var" ? "var" : "let";
      this._destructureTarget(variable as PatternNode, patternSlot!, kind);
    } else if (isScriptVar) {
      if (varGlobalNameIdx === null) {
        throw new Error("For-in global binding is missing a name constant");
      }
      this.func.emit(bytecode.ROP_STA_GLOBAL, varGlobalNameIdx);
    } else {
      if (varSlot === null) {
        throw new Error("For-in local binding is missing a slot");
      }
      this.func.emit(bytecode.ROP_STAR, varSlot);
    }

    if (node.body.type === "BlockStatement") {
      this.compileStatements(blockBodyStatements(node.body));
    } else {
      this.compileStatement(node.body);
    }

    const continueTarget = this.func.instructions.length;
    if (varSlot !== null && node.kind !== "var" && this._bodyMayCapture(node.body)) {
      this.func.emit(bytecode.ROP_CLOSE_UPVALUES, varSlot);
    }
    this.func.emit(bytecode.ROP_LDA_REG, iSlot);
    const oneIdx = this.func.addConstant(1);
    const oneReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_LDA_CONST, oneIdx);
    this.func.emit(bytecode.ROP_STAR, oneReg);
    this.func.emit(bytecode.ROP_LDA_REG, iSlot);
    const addFb = this.func.allocFeedbackSlot();
    this.func.emit(bytecode.ROP_ADD, oneReg, addFb);
    this.func.emit(bytecode.ROP_STAR, iSlot);
    this.temps.free(oneReg);

    this.func.emit(bytecode.ROP_JUMP, loopStart);
    const endTarget = this.func.instructions.length;
    this.func.patchJump(exitJump, endTarget);
    for (const j of breakJumps) this.func.patchJump(j, endTarget);
    for (const j of continueJumps) this.func.patchJump(j, continueTarget);

    this._breakJumps = outerBreak;
    this._continueJumps = outerContinue;
    this.scope = outerScope;
  },

  compileForOfStatement(node) {
    this.compileExpression(node.iterable);
    this.func.emit(bytecode.ROP_GET_ITERATOR);
    const iterSlot = this.func.addLocal("_iter$");
    this.func.emit(bytecode.ROP_STAR, iterSlot);
    const iterResultSlot = this.func.addLocal("_iterResult$");
    const outerScope = this.scope;
    this.scope = new Scope(outerScope);
    const variable = node.variable;
    const variableName = directBindingName(variable);
    const isPattern = variableName === null;
    const isScriptVar =
      !isPattern && outerScope.isInScriptScope() && node.kind === "var";
    let varSlot: number | null = null;
    let varGlobalNameIdx: number | null = null;
    let patternSlot: number | null = null;
    if (isPattern) {
      patternSlot = this.func.addLocal("_forOfItem$");
    } else if (isScriptVar) {
      varGlobalNameIdx = this.func.addConstant(variableName);
    } else if (node.kind === "var") {
      const varResolved = outerScope.resolve(variableName);
      varSlot = varResolved
        ? varResolved.slot
        : this._declareLocal(variableName, "var");
      if (!varResolved) this.func.setLocalBindingKind(varSlot, "var");
    } else {
      const kind = node.kind === "const" ? "const" : "let";
      varSlot = this._declareLocal(variableName, kind);
      this.func.setLocalBindingKind(varSlot, kind);
    }

    const outerBreak = this._breakJumps;
    const outerContinue = this._continueJumps;
    const breakJumps: number[] = [];
    const continueJumps: number[] = [];
    this._breakJumps = breakJumps;
    this._continueJumps = continueJumps;

    const loopStart = this.func.instructions.length;

    this.func.emit(bytecode.ROP_LDA_REG, iterSlot);
    this.func.emit(bytecode.ROP_ITER_NEXT);
    this.func.emit(bytecode.ROP_STAR, iterResultSlot);

    this.func.emit(bytecode.ROP_LDA_REG, iterResultSlot);
    this.func.emit(bytecode.ROP_ITER_DONE);
    const exitJump = this.func.emit(bytecode.ROP_JUMP_IF_TRUE, 0);

    this.func.emit(bytecode.ROP_LDA_REG, iterResultSlot);
    this.func.emit(bytecode.ROP_ITER_VALUE);
    if (isPattern) {
      this.func.emit(bytecode.ROP_STAR, patternSlot!);
      const kind = node.kind === "const" ? "const" : node.kind === "var" ? "var" : "let";
      this._destructureTarget(variable as PatternNode, patternSlot!, kind);
    } else if (isScriptVar) {
      this.func.emit(bytecode.ROP_STA_GLOBAL, varGlobalNameIdx!);
    } else {
      this.func.emit(bytecode.ROP_STAR, varSlot!);
    }

    if (node.body.type === "BlockStatement") {
      this.compileStatements(blockBodyStatements(node.body));
    } else {
      this.compileStatement(node.body);
    }

    const continueTarget = this.func.instructions.length;
    if (varSlot !== null && node.kind !== "var" && this._bodyMayCapture(node.body)) {
      this.func.emit(bytecode.ROP_CLOSE_UPVALUES, varSlot);
    }
    this.func.emit(bytecode.ROP_JUMP, loopStart);
    const endTarget = this.func.instructions.length;
    this.func.patchJump(exitJump, endTarget);
    for (const j of breakJumps) this.func.patchJump(j, endTarget);
    for (const j of continueJumps) this.func.patchJump(j, continueTarget);

    this._breakJumps = outerBreak;
    this._continueJumps = outerContinue;
    this.scope = outerScope;
  },

  compileObjectDestructuring(node) {
    const srcReg = this.temps.alloc();
    this.compileExpression(node.init);
    this.func.emit(bytecode.ROP_STAR, srcReg);
    this._destructureTarget(node.pattern, srcReg, node.kind);
    this.temps.free(srcReg);
  },

  compileArrayDestructuring(node) {
    const srcReg = this.temps.alloc();
    this.compileExpression(node.init);
    this.func.emit(bytecode.ROP_STAR, srcReg);
    this._destructureTarget(node.pattern, srcReg, node.kind);
    this.temps.free(srcReg);
  },

  _patternSlot(name, kind) {
    const bindKind = kind === "const" ? "const" : kind === "var" ? "var" : "let";
    const resolved = this.scope.resolve(name);
    const slot = resolved ? resolved.slot : this._declareLocal(name, bindKind);
    if (!resolved) this.func.setLocalBindingKind(slot, bindKind);
    return slot;
  },

  
  
  _applyPatternDefault(target, srcReg) {
    if (target.default === undefined) return srcReg;
    const undefReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_LDA_UNDEFINED);
    this.func.emit(bytecode.ROP_STAR, undefReg);
    this.func.emit(bytecode.ROP_LDA_REG, srcReg);
    this.func.emit(bytecode.ROP_EQ, undefReg, this.func.allocFeedbackSlot());
    const skip = this.func.emit(bytecode.ROP_JUMP_IF_FALSE, 0);
    this.compileExpression(target.default);
    this.func.emit(bytecode.ROP_STAR, srcReg);
    this.func.patchJump(skip, this.func.instructions.length);
    this.temps.free(undefReg);
    return srcReg;
  },

  _destructureTarget(target, srcReg, kind) {
    if (typeof target === "string") {
      const slot = this._patternSlot(target, kind);
      this.func.emit(bytecode.ROP_LDA_REG, srcReg);
      this.func.emit(bytecode.ROP_STAR, slot);
      return;
    }

    this._applyPatternDefault(target, srcReg);

    if (target.kind === "id") {
      const slot = this._patternSlot(requirePatternName(target, "identifier"), kind);
      this.func.emit(bytecode.ROP_LDA_REG, srcReg);
      this.func.emit(bytecode.ROP_STAR, slot);
      return;
    }

    if (target.kind === "array") {
      const elements = target.elements ?? [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el === null) continue;
        const elReg = this.temps.alloc();
        const idxReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_LDA_CONST, this.func.addConstant(i));
        this.func.emit(bytecode.ROP_STAR, idxReg);
        this.func.emit(
          bytecode.ROP_LDA_INDEX,
          srcReg,
          idxReg,
          this.func.allocFeedbackSlot(),
        );
        this.func.emit(bytecode.ROP_STAR, elReg);
        this.temps.free(idxReg);
        this._destructureTarget(el, elReg, kind);
        this.temps.free(elReg);
      }
      if (target.rest) {
        const restReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_LDA_REG, srcReg);
        this.func.emit(
          bytecode.ROP_ARRAY_REST,
          this.func.addConstant(elements.length),
        );
        this.func.emit(bytecode.ROP_STAR, restReg);
        this._destructureTarget(
          requirePatternRestPattern(target.rest, "array rest"),
          restReg,
          kind,
        );
        this.temps.free(restReg);
      }
      return;
    }

    if (target.kind === "object") {
      const keys: string[] = [];
      for (const { key, value } of target.props ?? []) {
        keys.push(key);
        const vReg = this.temps.alloc();
        this.func.emit(
          bytecode.ROP_LDA_PROP,
          srcReg,
          this.func.addConstant(key),
          this.func.allocFeedbackSlot(),
        );
        this.func.emit(bytecode.ROP_STAR, vReg);
        this._destructureTarget(value, vReg, kind);
        this.temps.free(vReg);
      }
      if (target.rest) {
        const restTarget = requirePatternRestPattern(target.rest, "object rest");
        const slot = this._patternSlot(requirePatternName(restTarget, "object rest"), kind);
        this.func.emit(bytecode.ROP_LDA_REG, srcReg);
        this.func.emit(
          bytecode.ROP_OBJECT_REST,
          this.func.addConstant(keys),
        );
        this.func.emit(bytecode.ROP_STAR, slot);
      }
      return;
    }
  },
};

import { NodeType } from "../../../frontend/ast/index.js";
import type { ASTNode } from "../../../frontend/ast/index.js";
import { Scope } from "./helpers.js";
import type { ScopeResolution } from "./helpers.js";
import { TempAllocator } from "./temp-allocator.js";
import * as bytecode from "../ops/bytecode.js";

type PatternNode = {
  kind: "id" | "array" | "object";
  name?: string;
  default?: ASTNode;
  elements?: Array<PatternNode | null>;
  rest?: PatternNode | string;
  props?: Array<{ key: string; value: PatternNode }>;
};

type ParamNode =
  | string
  | {
      rest?: boolean;
      name?: string;
      default?: ASTNode;
      pattern?: PatternNode;
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
};

type ClassMethodNode = {
  name: string;
  kind?: "get" | "set" | string;
  func: FunctionNode & { name: string; params: string[] };
};

type ClassNode = ASTNode & {
  name: string;
  superClass?: { name: string } | null;
  constructor?: FunctionNode;
  methods: ClassMethodNode[];
};

type ForInNode = ASTNode & {
  variable: string;
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
  return typeof param === "string" || !param.rest;
}

function requireParamName(param: Exclude<ParamNode, string>, context: string): string {
  if (!param.name) {
    throw new Error(`[RegCompiler] Missing parameter name for ${context}`);
  }
  return param.name;
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

function requirePatternRestPattern(rest: PatternNode | string, context: string): PatternNode {
  if (typeof rest === "string") {
    return { kind: "id", name: rest };
  }
  return rest;
}

type FunctionCompilerThis = {
  func: bytecode.RegisterCompiledFunction;
  scope: Scope;
  temps: TempAllocator;
  _currentSuperClassName?: string | null;
  _nextFunctionIsClassConstructor?: boolean;
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
      if (typeof param === "string") {
        const slot = innerFunc.addLocal(param);
        innerScope.define(param, slot);
        slots.push(slot);
        paramNames.push(param);
        positionalIndex++;
      } else if (param.rest) {
        const name = requireParamName(param, "rest parameter");
        const slot = innerFunc.addLocal(name);
        innerScope.define(name, slot);
        slots.push(slot);
      } else if (param.pattern) {
        slots.push(innerFunc.addLocal("_param$" + positionalIndex));
        paramNames.push("_param$" + positionalIndex);
        positionalIndex++;
      } else if (param.default) {
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
      const slot = slots[i]!;
      if (typeof param === "string") {
        continue;
      } else if (param.rest) {
        const normalCount = params.filter(
          (p) => isPositionalParam(p),
        ).length;
        innerFunc.emit(bytecode.ROP_REST_ARGS, normalCount);
        innerFunc.emit(bytecode.ROP_STAR, slot);
      } else if (param.default) {
        innerFunc.emit(bytecode.ROP_LDA_REG, slot);
        innerFunc.emit(bytecode.ROP_IS_NULLISH);
        const jumpPastDefault = innerFunc.emit(bytecode.ROP_JUMP_IF_FALSE, 0);
        this.compileExpression(param.default);
        innerFunc.emit(bytecode.ROP_STAR, slot);
        innerFunc.patchJump(jumpPastDefault, innerFunc.instructions.length);
      }
      if (param.pattern) {
        this._destructureTarget(param.pattern, slot, "let");
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
    innerFunc.isAsync = !!node.async;
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

  compileClassDeclaration(node) {
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

    const ctorNode: FunctionNode = node.constructor || (node.superClass ? {
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
    ctorNode.name = node.name;
    ctorNode._superClassName = node.superClass ? node.name : null;
    this._nextFunctionIsClassConstructor = true;
    this.compileFunctionDeclaration(ctorNode);

    const classResolvedForPrototype = this.scope.resolve(node.name);
    if (classResolvedForPrototype && classResolvedForPrototype.type === "local") {
      this.func.emit(bytecode.ROP_LDA_REG, classResolvedForPrototype.slot);
    } else {
      const classNameIdx = this.func.addConstant(node.name);
      this.func.emit(bytecode.ROP_LDA_GLOBAL, classNameIdx);
    }
    const classRegForPrototype = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, classRegForPrototype);
    const prototypeNameIdx = this.func.addConstant("prototype");
    const prototypeFbSlot = this.func.allocFeedbackSlot();
    this.func.emit(bytecode.ROP_LDA_PROP, classRegForPrototype, prototypeNameIdx, prototypeFbSlot);
    this.temps.free(classRegForPrototype);

    if (node.superClass) {
      const classResolved = this.scope.resolve(node.name);
      if (classResolved && classResolved.type === "local") {
        this.func.emit(bytecode.ROP_LDA_REG, classResolved.slot);
      } else {
        const classNameIdx = this.func.addConstant(node.name);
        this.func.emit(bytecode.ROP_LDA_GLOBAL, classNameIdx);
      }
      const subCtorReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, subCtorReg);
      const protoStr = this.func.addConstant("prototype");
      const fbSlot1 = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_PROP, subCtorReg, protoStr, fbSlot1);
      const subProtoReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, subProtoReg);

      this.func.emit(bytecode.ROP_LDA_REG, superClassReg);
      const superCtorReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, superCtorReg);
      const fbSlot2 = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_PROP, superCtorReg, protoStr, fbSlot2);
      const superProtoReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, superProtoReg);

      this.func.emit(bytecode.ROP_SET_PROTO, subProtoReg, superProtoReg);

      this.temps.free(superProtoReg);
      this.temps.free(superCtorReg);
      this.temps.free(subProtoReg);
      this.temps.free(subCtorReg);
    }

    for (const method of node.methods) {
      const resolved = this.scope.resolve(node.name);
      if (resolved && resolved.type === "local") {
        this.func.emit(bytecode.ROP_LDA_REG, resolved.slot);
      } else {
        const nameIdx = this.func.addConstant(node.name);
        this.func.emit(bytecode.ROP_LDA_GLOBAL, nameIdx);
      }

      const protoReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, protoReg);
      const protoConstIdx = this.func.addConstant("prototype");
      const protoFbSlot = this.func.allocFeedbackSlot();
      this.func.emit(
        bytecode.ROP_LDA_PROP,
        protoReg,
        protoConstIdx,
        protoFbSlot,
      );

      const protoObjReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, protoObjReg);

      const outerFunc = this.func;
      const outerScope = this.scope;
      const outerTemps = this.temps;
      const outerSuperClassName = this._currentSuperClassName;

      const methodFunc = new bytecode.RegisterCompiledFunction(
        method.func.name,
        method.func.params.filter((p: ParamNode) => isPositionalParam(p)).length,
      );
      this.func = methodFunc;
      this.scope = new Scope(outerScope);
      this.scope.isFunctionBoundary = true;
      this.temps = new TempAllocator(methodFunc);
      this._currentSuperClassName = node.superClass ? node.name : null;

      this._compileParams(method.func.params, methodFunc, this.scope);

      if (method.func.body.type === NodeType.BlockStatement) {
        this.compileStatements(blockBodyStatements(method.func.body));
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

      if (methodFunc.upvalues.length > 0) {
        const constIdx = outerFunc.addConstant(methodFunc);
        outerFunc.emit(bytecode.ROP_MAKE_CLOSURE, constIdx);
      } else {
        const constIdx = outerFunc.addConstant(methodFunc);
        outerFunc.emit(bytecode.ROP_LDA_CONST, constIdx);
      }

      const methodNameIdx = outerFunc.addConstant(method.name);
      if (method.kind === "get" || method.kind === "set") {
        const fnReg = this.temps.alloc();
        outerFunc.emit(bytecode.ROP_STAR, fnReg);
        const getterReg = method.kind === "get" ? fnReg : -1;
        const setterReg = method.kind === "set" ? fnReg : -1;
        outerFunc.emit(
          bytecode.ROP_DEFINE_ACCESSOR,
          protoObjReg,
          methodNameIdx,
          getterReg,
          setterReg,
        );
        this.temps.free(fnReg);
      } else {
        const setFbSlot = outerFunc.allocFeedbackSlot();
        outerFunc.emit(
          bytecode.ROP_STA_PROP,
          protoObjReg,
          methodNameIdx,
          setFbSlot,
        );
      }

      this.temps.free(protoObjReg);
      this.temps.free(protoReg);
    }
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
    const isScriptVar = outerScope.isInScriptScope() && node.kind === "var";
    let varSlot = null;
    let varGlobalNameIdx = null;
    if (isScriptVar) {
      varGlobalNameIdx = this.func.addConstant(node.variable);
    } else if (node.kind === "var") {
      const varResolved = outerScope.resolve(node.variable);
      varSlot = varResolved
        ? varResolved.slot
        : this._declareLocal(node.variable, "var");
      if (!varResolved) this.func.setLocalBindingKind(varSlot, "var");
    } else {
      const kind = node.kind === "const" ? "const" : "let";
      varSlot = this._declareLocal(node.variable, kind);
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
    if (isScriptVar) {
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
    const isPattern = typeof variable === "object" && variable !== null;
    const isScriptVar =
      !isPattern && outerScope.isInScriptScope() && node.kind === "var";
    let varSlot: number | null = null;
    let varGlobalNameIdx: number | null = null;
    let patternSlot: number | null = null;
    if (isPattern) {
      patternSlot = this.func.addLocal("_forOfItem$");
    } else if (isScriptVar) {
      varGlobalNameIdx = this.func.addConstant(variable);
    } else if (node.kind === "var") {
      const varResolved = outerScope.resolve(variable);
      varSlot = varResolved
        ? varResolved.slot
        : this._declareLocal(variable, "var");
      if (!varResolved) this.func.setLocalBindingKind(varSlot, "var");
    } else {
      const kind = node.kind === "const" ? "const" : "let";
      varSlot = this._declareLocal(variable, kind);
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
      this._destructureTarget(variable, patternSlot!, kind);
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

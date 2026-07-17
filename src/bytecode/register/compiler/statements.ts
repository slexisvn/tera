import { NodeType } from "../../../frontend/ast/index.js";
import type { ASTNode } from "../../../frontend/ast/index.js";
import { Scope } from "./helpers.js";
import type { TempAllocator } from "./temp-allocator.js";
import * as bytecode from "../ops/bytecode.js";

type BindingKind = "let" | "const" | "var";

type StatementNode = ASTNode & {
  type: string;
  _hoisted?: boolean;
  _mayCapture?: boolean;
  name?: string;
  init?: ASTNode | ASTNode[] | null;
  test?: ASTNode | null;
  consequent?: ASTNode | ASTNode[];
  alternate?: ASTNode | null;
  body?: StatementNode | ASTNode | ASTNode[];
  expression?: ASTNode;
  discriminant?: ASTNode;
  cases?: StatementNode[];
  block?: StatementNode & { body: ASTNode[] };
  handler?: { param?: string; body: StatementNode & { body: ASTNode[] } };
  finalizer?: StatementNode | null;
  argument?: ASTNode;
  label?: string;
  update?: ASTNode | null;
  kind?: BindingKind;
  param?: string;
};

function statementList(value: ASTNode | ASTNode[] | StatementNode): ASTNode[] {
  return Array.isArray(value) ? value : [value];
}

function isASTNode(value: RuntimeValue | ASTNode | null | undefined): value is ASTNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function singleStatement(
  value: ASTNode | ASTNode[] | StatementNode | null | undefined,
  context: string,
): ASTNode {
  if (!value || Array.isArray(value)) {
    throw new Error(`[RegCompiler] Expected statement for ${context}`);
  }
  return value;
}

function expressionNode(
  value: ASTNode | ASTNode[] | null | undefined,
  context: string,
): ASTNode {
  if (!value || Array.isArray(value)) {
    throw new Error(`[RegCompiler] Expected expression for ${context}`);
  }
  return value;
}

function requiredName(node: StatementNode, context: string): string {
  if (!node.name) {
    throw new Error(`[RegCompiler] Missing name for ${context}`);
  }
  return node.name;
}

function requiredLabel(node: StatementNode, context: string): string {
  if (!node.label) {
    throw new Error(`[RegCompiler] Missing label for ${context}`);
  }
  return node.label;
}

function astNodeList(values: RuntimeValue[] | ASTNode[]): ASTNode[] {
  const nodes: ASTNode[] = [];
  for (const value of values) {
    if (isASTNode(value)) nodes.push(value);
  }
  return nodes;
}

function blockBody(
  value: ASTNode | ASTNode[] | StatementNode | null | undefined,
): ASTNode[] {
  if (!value) return [];
  if (Array.isArray(value)) return astNodeList(value);
  const possibleBody = value.body;
  if (Array.isArray(possibleBody)) {
    return astNodeList(possibleBody);
  }
  return [value];
}

type StatementCompilerThis = {
  func: bytecode.RegisterCompiledFunction;
  scope: Scope;
  temps: TempAllocator;
  _breakJumps: number[];
  _continueJumps: number[];
  _finallyBlocks: Array<{ body: ASTNode[] }>;
  _labeledBreaks: Record<string, number[]>;
  _labeledContinues: Record<string, number[]>;
  compileStatement(node: ASTNode): void;
  compileStatements(nodes: ASTNode[]): void;
  compileFunctionDeclaration(node: ASTNode): void;
  compileLazyFunctionDeclaration(node: ASTNode): void;
  compileLetDeclaration(node: StatementNode): void;
  compileIfStatement(node: StatementNode): void;
  compileWhileStatement(node: StatementNode): void;
  compileForStatement(node: StatementNode): void;
  compileReturnStatement(node: StatementNode): void;
  compileBlock(node: StatementNode): void;
  compileExpressionStatement(node: StatementNode): void;
  compileSwitchStatement(node: StatementNode): void;
  compileBreakStatement(node: StatementNode): void;
  compileTryStatement(node: StatementNode): void;
  compileThrowStatement(node: StatementNode): void;
  compileClassDeclaration(node: ASTNode): void;
  compileForInStatement(node: ASTNode): void;
  compileForOfStatement(node: ASTNode): void;
  compileObjectDestructuring(node: ASTNode): void;
  compileArrayDestructuring(node: ASTNode): void;
  compileDoWhileStatement(node: StatementNode): void;
  compileContinueStatement(node: StatementNode): void;
  compileLabeledStatement(node: StatementNode): void;
  compileExpression(node: ASTNode): void;
  _declareLocal(name: string, kind: BindingKind | "class"): number;
  _bodyMayCapture(node: RuntimeValue | ASTNode | ASTNode[] | null | undefined): boolean;
  _prescanBlockScopedLocals(nodes: ASTNode[]): void;
  _emitHoistedFunctionDeclarations(nodes: ASTNode[]): void;
};

type StatementMethodMap = {
  [name: string]: (this: StatementCompilerThis, node: StatementNode) => void | boolean;
} & ThisType<StatementCompilerThis>;

export const statementMethods: StatementMethodMap = {
  compileStatement(node) {
    switch (node.type as string) {
      case NodeType.EmptyStatement:
        return;
      case NodeType.FunctionDeclaration:
        if (node._hoisted) return;
        return this.compileFunctionDeclaration(node);
      case NodeType.LetDeclaration:
      case NodeType.ConstDeclaration:
      case NodeType.VarDeclaration:
        return this.compileLetDeclaration(node);
      case NodeType.IfStatement:
        return this.compileIfStatement(node);
      case NodeType.WhileStatement:
        return this.compileWhileStatement(node);
      case NodeType.ForStatement:
        return this.compileForStatement(node);
      case NodeType.ReturnStatement:
        return this.compileReturnStatement(node);
      case NodeType.BlockStatement:
        return this.compileBlock(node);
      case NodeType.ExpressionStatement:
        return this.compileExpressionStatement(node);
      case NodeType.SwitchStatement:
        return this.compileSwitchStatement(node);
      case NodeType.BreakStatement:
        return this.compileBreakStatement(node);
      case NodeType.TryStatement:
        return this.compileTryStatement(node);
      case NodeType.ThrowStatement:
        return this.compileThrowStatement(node);
      case NodeType.ClassDeclaration:
        return this.compileClassDeclaration(node);
      case NodeType.ForInStatement:
        return this.compileForInStatement(node);
      case NodeType.ForOfStatement:
        return this.compileForOfStatement(node);
      case NodeType.LazyFunctionDeclaration:
        if (node._hoisted) return;
        return this.compileLazyFunctionDeclaration(node);
      case NodeType.ObjectDestructuring:
        return this.compileObjectDestructuring(node);
      case NodeType.ArrayDestructuring:
        return this.compileArrayDestructuring(node);
      case NodeType.DoWhileStatement:
        return this.compileDoWhileStatement(node);
      case NodeType.ContinueStatement:
        return this.compileContinueStatement(node);
      case NodeType.LabeledStatement:
        return this.compileLabeledStatement(node);
      default:
        throw new Error(`[RegCompiler] Unknown statement type '${node.type}'`);
    }
  },

  compileLetDeclaration(node) {
    const name = requiredName(node, "declaration");
    const isScriptVar = this.scope.isInScriptScope() && node.type === NodeType.VarDeclaration;

    if (isScriptVar) {
      if (node.init === null || node.init === undefined) return;
      this.compileExpression(expressionNode(node.init, "var initializer"));
      const nameIdx = this.func.addConstant(name);
      this.func.emit(bytecode.ROP_STA_GLOBAL, nameIdx);
      return;
    }

    const kind =
      node.type === NodeType.ConstDeclaration
        ? "const"
        : node.type === NodeType.VarDeclaration
          ? "var"
          : "let";
    const resolved =
      kind === "var"
        ? this.scope.resolve(name)
        : this.scope.locals.has(name)
          ? this.scope.resolve(name)
          : null;
    const slot = resolved ? resolved.slot : this._declareLocal(name, kind);
    if (!resolved) {
      this.func.setLocalBindingKind(slot, kind);
    }

    if (node.type === NodeType.VarDeclaration && node.init === null) {
      return;
    }

    if (node.init !== null) {
      this.compileExpression(expressionNode(node.init, "declaration initializer"));
    } else {
      this.func.emit(bytecode.ROP_LDA_UNDEFINED);
    }

    this.func.emit(bytecode.ROP_STAR, slot);
  },

  compileIfStatement(node) {
    this.compileExpression(expressionNode(node.test, "if test"));
    const jumpToElse = this.func.emit(bytecode.ROP_JUMP_IF_FALSE, 0);
    this.compileStatement(singleStatement(node.consequent, "if consequent"));

    if (node.alternate) {
      const jumpToEnd = this.func.emit(bytecode.ROP_JUMP, 0);
      this.func.patchJump(jumpToElse, this.func.instructions.length);
      this.compileStatement(singleStatement(node.alternate, "if alternate"));
      this.func.patchJump(jumpToEnd, this.func.instructions.length);
    } else {
      this.func.patchJump(jumpToElse, this.func.instructions.length);
    }
  },

  _bodyMayCapture(node) {
    if (!node || typeof node !== "object") return false;
    if (node._mayCapture !== undefined) return node._mayCapture;
    let result = false;
    switch (node.type as string) {
      case NodeType.FunctionExpression:
      case NodeType.ArrowFunctionExpression:
      case NodeType.FunctionDeclaration:
      case NodeType.LazyFunctionDeclaration:
      case "GeneratorFunctionDeclaration":
        result = true;
    }
    if (!result) {
      if (Array.isArray(node)) {
        for (const el of node as Array<RuntimeValue | ASTNode | ASTNode[]>) {
          if (this._bodyMayCapture(el)) {
            result = true;
            break;
          }
        }
        return result;
      }
      if (!isASTNode(node)) return false;
      for (const key in node) {
        if (key === "type" || key === "_mayCapture") continue;
        const fields = node as ASTNode & Record<string, RuntimeValue | ASTNode | ASTNode[] | undefined>;
        const value = fields[key];
        if (Array.isArray(value)) {
          for (const el of value) {
            if (this._bodyMayCapture(el)) {
              result = true;
              break;
            }
          }
        } else if (value && typeof value === "object") {
          result = this._bodyMayCapture(value);
        }
        if (result) break;
      }
    }
    node._mayCapture = result;
    return result;
  },

  compileWhileStatement(node) {
    const iterationScopeBase = this.func.registerCount;
    const body = singleStatement(node.body, "while body");
    const mayCapture = this._bodyMayCapture(body);
    const outerBreak = this._breakJumps;
    const outerContinue = this._continueJumps;
    const breakJumps: number[] = [];
    const continueJumps: number[] = [];
    this._breakJumps = breakJumps;
    this._continueJumps = continueJumps;

    const loopStart = this.func.instructions.length;
    this.compileExpression(expressionNode(node.test, "while test"));
    const jumpToEnd = this.func.emit(bytecode.ROP_JUMP_IF_FALSE, 0);
    this.compileStatement(body);

    const continueTarget = this.func.instructions.length;
    if (mayCapture) {
      this.func.emit(bytecode.ROP_CLOSE_UPVALUES, iterationScopeBase);
    }
    this.func.emit(bytecode.ROP_JUMP, loopStart);
    const endTarget = this.func.instructions.length;
    this.func.patchJump(jumpToEnd, endTarget);
    for (const j of breakJumps) this.func.patchJump(j, endTarget);
    for (const j of continueJumps) this.func.patchJump(j, continueTarget);

    this._breakJumps = outerBreak;
    this._continueJumps = outerContinue;
  },

  compileForStatement(node) {
    const outerScope = this.scope;
    this.scope = new Scope(outerScope);
    const iterationScopeBase = this.func.registerCount;
    const body = singleStatement(node.body, "for body");
    const mayCapture = this._bodyMayCapture(body);
    const outerBreak = this._breakJumps;
    const outerContinue = this._continueJumps;
    const breakJumps: number[] = [];
    const continueJumps: number[] = [];
    this._breakJumps = breakJumps;
    this._continueJumps = continueJumps;

    if (node.init) {
      const inits = Array.isArray(node.init) ? node.init : [node.init];
      for (const i of inits) {
        if (
          i.type === NodeType.LetDeclaration ||
          i.type === NodeType.ConstDeclaration ||
          i.type === NodeType.VarDeclaration
        ) {
          this.compileLetDeclaration(singleStatement(i, "for declaration"));
        } else {
          this.compileStatement(i);
        }
      }
    }

    const loopStart = this.func.instructions.length;

    if (node.test) {
      this.compileExpression(expressionNode(node.test, "for test"));
    } else {
      this.func.emit(bytecode.ROP_LDA_TRUE);
    }
    const jumpToEnd = this.func.emit(bytecode.ROP_JUMP_IF_FALSE, 0);

    this.compileStatement(body);

    const updateStart = this.func.instructions.length;
    if (mayCapture) {
      this.func.emit(bytecode.ROP_CLOSE_UPVALUES, iterationScopeBase);
    }
    if (node.update) {
      this.compileExpression(node.update);
    }

    this.func.emit(bytecode.ROP_JUMP, loopStart);
    const endTarget = this.func.instructions.length;
    this.func.patchJump(jumpToEnd, endTarget);
    for (const j of breakJumps) this.func.patchJump(j, endTarget);
    for (const j of continueJumps) this.func.patchJump(j, updateStart);

    this._breakJumps = outerBreak;
    this._continueJumps = outerContinue;
    this.scope = outerScope;
  },

  compileReturnStatement(node) {
    if (node.argument) {
      this.compileExpression(node.argument);
    } else {
      this.func.emit(bytecode.ROP_LDA_UNDEFINED);
    }
    if (this._finallyBlocks.length > 0) {
      var retReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, retReg);
      var saved = this._finallyBlocks;
      for (var i = saved.length - 1; i >= 0; i--) {
        this.func.emit(bytecode.ROP_TRY_END);
        this._finallyBlocks = saved.slice(0, i);
        this.compileStatements(saved[i].body);
      }
      this._finallyBlocks = saved;
      this.func.emit(bytecode.ROP_LDA_REG, retReg);
      this.temps.free(retReg);
    }
    this.func.emit(bytecode.ROP_RETURN);
  },

  compileBlock(node) {
    this.scope = new Scope(this.scope);
    const body = blockBody(node.body);
    this._prescanBlockScopedLocals(body);
    this._emitHoistedFunctionDeclarations(body);
    this.compileStatements(body);
    if (this.scope.parent) this.scope = this.scope.parent;
  },

  compileExpressionStatement(node) {
    this.compileExpression(expressionNode(node.expression, "expression statement"));
  },

  compileSwitchStatement(node) {
    const discReg = this.temps.alloc();
    this.compileExpression(expressionNode(node.discriminant, "switch discriminant"));
    this.func.emit(bytecode.ROP_STAR, discReg);

    const outerBreakJumps = this._breakJumps;
    const breakJumps: number[] = [];
    this._breakJumps = breakJumps;

    
    
    
    
    const cases = node.cases ?? [];
    const bodyDispatch = new Array<number | null>(cases.length).fill(null);
    let defaultIndex = -1;
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      if (c.test === null || c.test === undefined) {
        defaultIndex = i;
        continue;
      }
      this.func.emit(bytecode.ROP_LDA_REG, discReg);
      this.compileExpression(c.test);
      const tmpReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, tmpReg);
      this.func.emit(bytecode.ROP_LDA_REG, discReg);
      this.func.emit(bytecode.ROP_EQ, tmpReg, this.func.allocFeedbackSlot());
      this.temps.free(tmpReg);
      bodyDispatch[i] = this.func.emit(bytecode.ROP_JUMP_IF_TRUE, 0);
    }
    const dispatchToDefault = this.func.emit(bytecode.ROP_JUMP, 0);

    
    const bodyTargets = new Array<number>(cases.length);
    for (let i = 0; i < cases.length; i++) {
      bodyTargets[i] = this.func.instructions.length;
      for (const stmt of statementList(cases[i]!.consequent ?? [])) {
        this.compileStatement(stmt);
      }
    }
    const endTarget = this.func.instructions.length;

    for (let i = 0; i < cases.length; i++) {
      const dispatchJump = bodyDispatch[i];
      if (dispatchJump !== null) {
        this.func.patchJump(dispatchJump, bodyTargets[i]);
      }
    }
    this.func.patchJump(
      dispatchToDefault,
      defaultIndex >= 0 ? bodyTargets[defaultIndex] : endTarget,
    );
    for (const j of breakJumps) {
      this.func.patchJump(j, endTarget);
    }

    this.temps.free(discReg);
    this._breakJumps = outerBreakJumps;
  },

  compileBreakStatement(node) {
    if (node.label && this._labeledBreaks && this._labeledBreaks[node.label]) {
      this._labeledBreaks[node.label].push(
        this.func.emit(bytecode.ROP_JUMP, 0),
      );
    } else if (this._breakJumps) {
      this._breakJumps.push(this.func.emit(bytecode.ROP_JUMP, 0));
    }
  },

  compileTryStatement(node) {
    const finalizer = node.finalizer;
    const handler = node.handler;
    const hasFinally = !!finalizer;
    const hasCatch = !!handler;

    if (finalizer) {
      this._finallyBlocks.push({ body: blockBody(finalizer.body) });

      const outerTryStart = this.func.emit(bytecode.ROP_TRY_START, 0);
      const innerTryStart = this.func.emit(bytecode.ROP_TRY_START, 0);
      this.compileStatements(blockBody(node.block?.body));
      this.func.emit(bytecode.ROP_TRY_END);
      const jumpOverCatch = this.func.emit(bytecode.ROP_JUMP, 0);

      const catchStart = this.func.instructions.length;
      this.func.patchJump(innerTryStart, catchStart);

      if (handler) {
        if (handler.param) {
          const resolved = this.scope.resolve(handler.param);
          const catchLocal = resolved
            ? resolved.slot
            : this.func.addLocal(handler.param);
          if (!resolved) this.scope.define(handler.param, catchLocal);
          this.func.emit(bytecode.ROP_STAR, catchLocal);
        }
        this.compileStatements(blockBody(handler.body.body));
      } else {
        this.func.emit(bytecode.ROP_THROW);
      }

      const afterCatch = this.func.instructions.length;
      this.func.patchJump(jumpOverCatch, afterCatch);

      this.func.emit(bytecode.ROP_TRY_END);
      this.compileStatements(blockBody(finalizer.body));
      const jumpPastOuter = this.func.emit(bytecode.ROP_JUMP, 0);

      const outerCatchStart = this.func.instructions.length;
      this.func.patchJump(outerTryStart, outerCatchStart);
      const exReg = this.func.allocTemp();
      this.func.emit(bytecode.ROP_STAR, exReg);
      this.compileStatements(blockBody(finalizer.body));
      this.func.emit(bytecode.ROP_LDA_REG, exReg);
      this.func.emit(bytecode.ROP_THROW);

      const afterAll = this.func.instructions.length;
      this.func.patchJump(jumpPastOuter, afterAll);
      this._finallyBlocks.pop();
    } else {
      const tryStartIdx = this.func.emit(bytecode.ROP_TRY_START, 0);
      this.compileStatements(blockBody(node.block?.body));
      this.func.emit(bytecode.ROP_TRY_END);
      const jumpOverCatch = this.func.emit(bytecode.ROP_JUMP, 0);

      const catchStart = this.func.instructions.length;
      this.func.patchJump(tryStartIdx, catchStart);

      if (handler) {
        if (handler.param) {
          const resolved = this.scope.resolve(handler.param);
          const catchLocal = resolved
            ? resolved.slot
            : this.func.addLocal(handler.param);
          if (!resolved) this.scope.define(handler.param, catchLocal);
          this.func.emit(bytecode.ROP_STAR, catchLocal);
        }
        this.compileStatements(blockBody(handler.body.body));
      }

      const afterCatch = this.func.instructions.length;
      this.func.patchJump(jumpOverCatch, afterCatch);
    }
  },

  compileThrowStatement(node) {
    this.compileExpression(expressionNode(node.argument, "throw argument"));
    this.func.emit(bytecode.ROP_THROW);
  },

  compileDoWhileStatement(node) {
    const outerBreak = this._breakJumps;
    const outerContinue = this._continueJumps;
    const breakJumps: number[] = [];
    const continueJumps: number[] = [];
    this._breakJumps = breakJumps;
    this._continueJumps = continueJumps;

    const loopStart = this.func.instructions.length;
    this.compileStatement(singleStatement(node.body, "do-while body"));
    const continueTarget = this.func.instructions.length;
    this.compileExpression(expressionNode(node.test, "do-while test"));
    this.func.emit(bytecode.ROP_JUMP_IF_TRUE, loopStart);
    const endTarget = this.func.instructions.length;
    for (const j of breakJumps) this.func.patchJump(j, endTarget);
    for (const j of continueJumps) this.func.patchJump(j, continueTarget);

    this._breakJumps = outerBreak;
    this._continueJumps = outerContinue;
  },

  compileContinueStatement(node) {
    if (
      node.label &&
      this._labeledContinues &&
      this._labeledContinues[node.label]
    ) {
      this._labeledContinues[node.label].push(
        this.func.emit(bytecode.ROP_JUMP, 0),
      );
    } else if (this._continueJumps) {
      this._continueJumps.push(this.func.emit(bytecode.ROP_JUMP, 0));
    }
  },

  compileLabeledStatement(node) {
    const label = requiredLabel(node, "labeled statement");
    if (!this._labeledBreaks) this._labeledBreaks = {};
    if (!this._labeledContinues) this._labeledContinues = {};
    this._labeledBreaks[label] = [];
    this._labeledContinues[label] = [];

    this.compileStatement(singleStatement(node.body, "labeled body"));

    const afterLabel = this.func.instructions.length;
    for (const jump of this._labeledBreaks[label] ?? []) {
      this.func.patchJump(jump, afterLabel);
    }
    delete this._labeledBreaks[label];
    delete this._labeledContinues[label];
  },
};

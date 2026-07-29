import { NodeType } from "../../../frontend/ast/index.js";
import type { ASTNode } from "../../../frontend/ast/index.js";
import { Scope } from "./helpers.js";
import * as bytecode from "../ops/bytecode.js";
import type { RuntimeInterfaceContract } from "../../../runtime/interface-contract.js";

import { TempAllocator } from "./temp-allocator.js";
import { scopeMethods } from "./scope.js";
import { statementMethods } from "./statements.js";
import { expressionMethods } from "./expressions.js";
import { functionMethods } from "./functions.js";

export { TempAllocator } from "./temp-allocator.js";
export { BINARY_OP_MAP } from "./expressions.js";

export type RegisterBytecodeCompilerOptions = {
  sourceName?: string | null;
};

export interface RegisterBytecodeCompiler {
  _withSourceNode<T>(node: ASTNode, run: () => T): T;
  _prepareFunctionBody(statements: ASTNode[]): void;
  _collectInterfaceDeclarations(statements: ASTNode[]): void;
  compileStatement(stmt: ASTNode): void;
  compileExpression(expr: ASTNode): void;
}

export class RegisterBytecodeCompiler {
  func: bytecode.RegisterCompiledFunction | null;
  scope: Scope | null;
  temps: TempAllocator | null;
  _breakJumps: RuntimeValue[] | null;
  _continueJumps: RuntimeValue[] | null;
  _finallyBlocks: RuntimeValue[];
  interfaceContracts: Map<string, RuntimeInterfaceContract>;
  classAbstractMembers: Map<string, Map<string, string>>;
  sourceName: string | null;

  constructor(options: RegisterBytecodeCompilerOptions = {}) {
    this.func = null;
    this.scope = null;
    this.temps = null;
    this._breakJumps = null;
    this._continueJumps = null;
    this._finallyBlocks = [];
    this.interfaceContracts = new Map();
    this.classAbstractMembers = new Map();
    this.sourceName = options.sourceName ?? null;
  }

  compile(ast: ASTNode): bytecode.RegisterCompiledFunction {
    if (ast.type !== NodeType.Program) {
      throw new Error(`[RegCompiler] Expected Program node, got '${ast.type}'`);
    }

    return bytecode.withCompiledFunctionSourceName(this.sourceName, () => {
      const func = new bytecode.RegisterCompiledFunction("<script>", 0);
      this.func = func;
      this.scope = new Scope();
      this.scope.isScript = true;
      this.temps = new TempAllocator(func);

      const body = ast.body as ASTNode[];
      this._collectInterfaceDeclarations(body);
      this._prepareFunctionBody(body);

      const last = body.length > 0 ? body[body.length - 1] : null;

      if (last && last.type === NodeType.ExpressionStatement) {
        this.compileStatements(body.slice(0, -1));
        this.compileExpression(last.expression as ASTNode);
        func.emit(bytecode.ROP_RETURN);
      } else {
        this.compileStatements(body);
        func.emit(bytecode.ROP_LDA_UNDEFINED);
        func.emit(bytecode.ROP_RETURN);
      }

      return func;
    });
  }

  compileStatements(statements: ASTNode[]): void {
    for (const stmt of statements) {
      this.compileStatement(stmt);
    }
  }

  _withSourceNode<T>(node: ASTNode, run: () => T): T {
    if (!this.func) return run();
    const line = node.__line;
    const column = node.__column;
    if (typeof line !== "number" || typeof column !== "number") return run();
    return this.func.withSourcePosition(
      { sourceName: this.sourceName, line, column },
      run,
    );
  }
}

Object.assign(RegisterBytecodeCompiler.prototype, scopeMethods);
Object.assign(RegisterBytecodeCompiler.prototype, statementMethods);
Object.assign(RegisterBytecodeCompiler.prototype, expressionMethods);
Object.assign(RegisterBytecodeCompiler.prototype, functionMethods);

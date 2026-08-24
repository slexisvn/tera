import type { RuntimeValue } from "../../../core/value/index.js";
import { NodeType } from "../../../frontend/ast/index.js";
import type { ASTNode } from "../../../frontend/ast/index.js";
import { Scope } from "./helpers.js";
import * as bytecode from "../ops/bytecode.js";
import type { RuntimeInterfaceContract } from "../../../runtime/interface-contract.js";
import { cellKey } from "../../../runtime/intrinsics/global-cells.js";

import { TempAllocator } from "./temp-allocator.js";
import { scopeMethods } from "./scope.js";
import { statementMethods } from "./statements.js";
import { expressionMethods } from "./expressions.js";
import { functionMethods } from "./functions.js";
import type { ConstructorSurface } from "./functions.js";

export { TempAllocator } from "./temp-allocator.js";
export { BINARY_OP_MAP } from "./expressions.js";

export type RegisterBytecodeCompilerOptions = {
  sourceName?: string | null;
  runtimeIntrinsics?: ReadonlySet<string>;
  moduleSpec?: string | null;
  isSharedGlobal?: (name: string) => boolean;
  moduleBindings?: ReadonlyMap<string, string>;
  moduleSpecs?: ReadonlySet<string>;
  moduleExports?: ReadonlyMap<string, string>;
  importedInterfaces?: ReadonlyMap<string, RuntimeInterfaceContract>;
};

export interface RegisterBytecodeCompiler {
  globalCellName(name: string): string;
  globalNameIndex(name: string): number;
  exportedCellName(moduleSpec: string, name: string): string;
  foldModuleMember(node: ASTNode | null | undefined): ASTNode | null;
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
  classConstructors: Map<string, ConstructorSurface>;
  sourceName: string | null;
  runtimeIntrinsics: ReadonlySet<string>;
  moduleSpec: string | null;
  isSharedGlobal: (name: string) => boolean;
  moduleBindings: ReadonlyMap<string, string>;
  moduleSpecs: ReadonlySet<string>;
  moduleExports: ReadonlyMap<string, string>;

  constructor(options: RegisterBytecodeCompilerOptions = {}) {
    this.func = null;
    this.scope = null;
    this.temps = null;
    this._breakJumps = null;
    this._continueJumps = null;
    this._finallyBlocks = [];
    this.interfaceContracts = new Map(options.importedInterfaces ?? []);
    this.classAbstractMembers = new Map();
    this.classConstructors = new Map();
    this.sourceName = options.sourceName ?? null;
    this.runtimeIntrinsics = options.runtimeIntrinsics ?? new Set();
    this.moduleSpec = options.moduleSpec ?? null;
    this.isSharedGlobal = options.isSharedGlobal ?? (() => false);
    this.moduleBindings = options.moduleBindings ?? new Map();
    this.moduleSpecs = options.moduleSpecs ?? new Set();
    this.moduleExports = options.moduleExports ?? new Map();
  }

  globalCellName(name: string): string {
    if (this.moduleSpec === null) return name;
    const key = cellKey(this.moduleSpec, name);
    const owner = this.moduleExports.get(key);
    if (owner !== undefined) return owner;
    return this.isSharedGlobal(name) ? name : key;
  }

  exportedCellName(moduleSpec: string, name: string): string {
    const key = cellKey(moduleSpec, name);
    return this.moduleExports.get(key) ?? key;
  }

  globalNameIndex(name: string): number {
    return this.func!.addConstant(this.globalCellName(name));
  }

  foldModuleMember(node: ASTNode | null | undefined): ASTNode | null {
    if (this.moduleBindings.size === 0) return null;
    if (!node || node.type !== NodeType.MemberExpression) return null;
    const properties: string[] = [];
    let current = node;
    while (
      current.type === NodeType.MemberExpression &&
      current.computed !== true &&
      typeof current.property === "string"
    ) {
      properties.unshift(current.property);
      current = current.object as ASTNode;
    }
    if (current.type !== NodeType.Identifier) return null;
    const root = String(current.name);
    if (this.scope!.resolve(root) !== null) return null;
    const spec = this.moduleBindings.get(root);
    if (spec === undefined) return null;

    let owner = spec;
    let at = 0;
    while (at < properties.length - 1 && this.moduleSpecs.has(`${owner}.${properties[at]}`)) {
      owner = `${owner}.${properties[at]!}`;
      at++;
    }
    let folded: ASTNode = {
      type: NodeType.Identifier,
      name: this.exportedCellName(owner, properties[at]!),
      resolvedCell: true,
    };
    for (let rest = at + 1; rest < properties.length; rest++) {
      folded = {
        type: NodeType.MemberExpression,
        object: folded,
        property: properties[rest]!,
        computed: false,
      };
    }
    return folded;
  }

  compile(ast: ASTNode): bytecode.RegisterCompiledFunction {
    if (ast.type !== NodeType.Program) {
      throw new Error(`[RegCompiler] Expected Program node, got '${ast.type}'`);
    }

    return bytecode.withCompiledFunctionModuleSpec(this.moduleSpec, () =>
      bytecode.withCompiledFunctionSourceName(this.sourceName, () => {
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
      }),
    );
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

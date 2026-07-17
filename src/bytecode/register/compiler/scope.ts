import { NodeType } from "../../../frontend/ast/index.js";
import type { ASTNode } from "../../../frontend/ast/index.js";
import type {
  LocalBindingKind,
  RegisterCompiledFunction,
} from "../ops/bytecode.js";

type BindingKind = LocalBindingKind | "function";

type PatternNode =
  | string
  | null
  | undefined
  | {
      kind?: string;
      name?: string;
      variable?: string | PatternNode;
      elements?: PatternNode[];
      props?: Array<{ value: PatternNode }>;
      rest?: string | PatternNode;
    };

type ScopeLike = {
  isScript?: boolean;
  locals: Map<string, number>;
  define(name: string, slot: number): void;
  defineVar(name: string, slot: number): void;
  defineFunction(name: string, slot: number): void;
  defineConst(name: string, slot: number): void;
};

type HoistableFunction = RegisterCompiledFunction & {
  hoistedVarSet?: Set<string>;
  hoistedVarNames: string[] | null;
};

type ScopeCompiler = {
  func: HoistableFunction;
  scope: ScopeLike;
  _declareLocal(name: string, kind?: BindingKind): number;
  _declareLexical(name: string, kind: BindingKind): number;
  _addHoistedVar(name: string): void;
  _declareForLoopBinding(node: ASTNode): void;
  _prescanStatement(node: ASTNode): void;
  _prescanLocals(statements: ASTNode[]): void;
  _hoistVars(statements: ASTNode[]): void;
  _hoistVarsFromNode(node: ASTNode | null | undefined): void;
  _emitHoistedFunctionDeclarations(statements: ASTNode[]): void;
  compileLazyFunctionDeclaration(node: ASTNode): void;
  compileFunctionDeclaration(node: ASTNode): void;
};

function asNodeArray(value: RuntimeValue): ASTNode[] {
  return Array.isArray(value) ? (value as ASTNode[]) : [];
}

function isNode(value: RuntimeValue): value is ASTNode {
  return !!value && typeof value === "object" && "type" in value;
}

export function collectPatternNames(
  target: PatternNode,
  out: string[] = [],
): string[] {
  if (!target) return out;
  if (typeof target === "string") {
    out.push(target);
    return out;
  }
  if (target.kind === "id") {
    if (typeof target.name === "string") out.push(target.name);
  } else if (target.kind === "array") {
    for (const el of target.elements ?? []) collectPatternNames(el, out);
    if (target.rest) collectPatternNames(target.rest, out);
  } else if (target.kind === "object") {
    for (const { value } of target.props ?? []) collectPatternNames(value, out);
    if (typeof target.rest === "string") out.push(target.rest);
    else if (target.rest) collectPatternNames(target.rest, out);
  }
  return out;
}

export const scopeMethods = {
  _declareLocal(this: ScopeCompiler, name: string, kind: BindingKind = "let") {
    if (this.scope.locals.has(name)) {
      return this.scope.locals.get(name)!;
    }
    const slot = this.func.addLocal(name);
    this.func.setLocalBindingKind(slot, kind as LocalBindingKind);
    if (kind === "const") {
      this.scope.defineConst(name, slot);
    } else if (kind === "var") {
      this.scope.defineVar(name, slot);
    } else if (kind === "function") {
      this.scope.defineFunction(name, slot);
    } else {
      this.scope.define(name, slot);
    }
    return slot;
  },

  _addHoistedVar(this: ScopeCompiler, name: string) {
    if (!this.func.hoistedVarNames) {
      this.func.hoistedVarNames = [];
      this.func.hoistedVarSet = new Set();
    }
    if (!this.func.hoistedVarSet!.has(name)) {
      this.func.hoistedVarSet!.add(name);
      this.func.hoistedVarNames.push(name);
    }
  },

  _declareForLoopBinding(this: ScopeCompiler, node: ASTNode) {
    const names =
      typeof node.variable === "string"
        ? [node.variable]
        : collectPatternNames(node.variable as PatternNode);
    const kind =
      node.kind === "const" ? "const" : node.kind === "var" ? "var" : "let";
    if (this.scope.isScript && node.kind === "var") {
      for (const name of names) this._addHoistedVar(name);
    } else {
      for (const name of names) this._declareLocal(name, kind);
    }
  },

  _declareLexical(this: ScopeCompiler, name: string, kind: BindingKind) {
    return this._declareLocal(name, kind);
  },

  _prescanLocals(this: ScopeCompiler, statements: ASTNode[]) {
    for (const stmt of statements) {
      this._prescanStatement(stmt);
    }
  },

  _prescanBlockScopedLocals(this: ScopeCompiler, statements: ASTNode[]) {
    for (const stmt of statements) {
      if (stmt.type === NodeType.LetDeclaration) {
        this._declareLexical(stmt.name as string, "let");
      } else if (stmt.type === NodeType.ConstDeclaration) {
        this._declareLexical(stmt.name as string, "const");
      } else if (
        stmt.type === NodeType.ObjectDestructuring ||
        stmt.type === NodeType.ArrayDestructuring
      ) {
        const kind = stmt.kind === "const" ? "const" : "let";
        for (const name of collectPatternNames(stmt.pattern as PatternNode)) {
          this._declareLexical(name, kind);
        }
      } else if (
        stmt.type === NodeType.FunctionDeclaration ||
        stmt.type === NodeType.LazyFunctionDeclaration ||
        (stmt.type as string) === "GeneratorFunctionDeclaration"
      ) {
        this._declareLocal(stmt.name as string, "function");
      }
    }
  },

  _prescanStatement(this: ScopeCompiler, node: ASTNode) {
    switch (node.type) {
      case NodeType.EmptyStatement:
        break;
      case NodeType.LetDeclaration:
      case NodeType.ConstDeclaration: {
        this._declareLexical(
          node.name as string,
          node.type === NodeType.ConstDeclaration ? "const" : "let",
        );
        break;
      }
      case NodeType.VarDeclaration: {
        if (this.scope.isScript) {
          this._addHoistedVar(node.name as string);
        } else {
          this._declareLocal(node.name as string, "var");
        }
        break;
      }
      case NodeType.FunctionDeclaration:
      case NodeType.LazyFunctionDeclaration: {
        if (!this.scope.isScript) {
          this._declareLocal(node.name as string, "function");
        }
        break;
      }
      case NodeType.ForInStatement: {
        this._declareLocal("_keys$", "var");
        this._declareLocal("_i$", "var");
        this._declareLocal("_len$", "var");
        this._declareForLoopBinding(node);
        break;
      }
      case NodeType.ForOfStatement: {
        this._declareLocal("_iter$", "var");
        this._declareLocal("_iterResult$", "var");
        this._declareForLoopBinding(node);
        break;
      }
      case NodeType.ObjectDestructuring:
      case NodeType.ArrayDestructuring: {
        const kind =
          node.kind === "const" ? "const" : node.kind === "var" ? "var" : "let";
        for (const name of collectPatternNames(node.pattern as PatternNode)) {
          this._declareLocal(name, kind);
        }
        break;
      }
      case NodeType.ForStatement: {
        const init = node.init;
        if (
          isNode(init) &&
          (init.type === NodeType.LetDeclaration ||
            init.type === NodeType.ConstDeclaration ||
            (init.type === NodeType.VarDeclaration && !this.scope.isScript))
        ) {
          this._declareLocal(
            init.name as string,
            init.type === NodeType.ConstDeclaration
              ? "const"
              : init.type === NodeType.VarDeclaration
                ? "var"
                : "let",
          );
        }
        break;
      }
      case NodeType.TryStatement: {
        const handler = node.handler as { param?: string } | null | undefined;
        if (handler?.param) {
          this._declareLocal(handler.param, "let");
        }
        break;
      }
      case NodeType.LabeledStatement:
        this._prescanStatement(node.body as ASTNode);
        break;
      default:
        break;
    }
  },

  _hoistVars(this: ScopeCompiler, statements: ASTNode[]) {
    for (const stmt of statements) {
      this._hoistVarsFromNode(stmt);
    }
  },

  _hoistVarsFromNode(this: ScopeCompiler, node: ASTNode | null | undefined) {
    if (!node) return;
    switch (node.type) {
      case NodeType.EmptyStatement:
        break;
      case NodeType.VarDeclaration: {
        if (this.scope.isScript) {
          this._addHoistedVar(node.name as string);
        } else if (!this.scope.locals.has(node.name as string)) {
          this._declareLocal(node.name as string, "var");
        }
        break;
      }
      case NodeType.BlockStatement:
        this._hoistVars(asNodeArray(node.body));
        break;
      case NodeType.IfStatement:
        this._hoistVarsFromNode(node.consequent as ASTNode);
        if (node.alternate) this._hoistVarsFromNode(node.alternate as ASTNode);
        break;
      case NodeType.WhileStatement:
        this._hoistVarsFromNode(node.body as ASTNode);
        break;
      case NodeType.ForStatement:
        if (isNode(node.init) && node.init.type === NodeType.VarDeclaration) {
          this._hoistVarsFromNode(node.init);
        }
        this._hoistVarsFromNode(node.body as ASTNode);
        break;
      case NodeType.ForInStatement:
      case NodeType.ForOfStatement:
        this._hoistVarsFromNode(node.body as ASTNode);
        break;
      case NodeType.TryStatement:
        if (node.block) this._hoistVarsFromNode(node.block as ASTNode);
        if (
          node.handler &&
          typeof node.handler === "object" &&
          (node.handler as { body?: ASTNode }).body
        ) {
          this._hoistVarsFromNode((node.handler as { body: ASTNode }).body);
        }
        if (node.finalizer) this._hoistVarsFromNode(node.finalizer as ASTNode);
        break;
      case NodeType.SwitchStatement:
        for (const c of asNodeArray(node.cases)) {
          for (const s of asNodeArray(c.consequent)) {
            this._hoistVarsFromNode(s);
          }
        }
        break;
      case NodeType.LabeledStatement:
        this._hoistVarsFromNode(node.body as ASTNode);
        break;
      default:
        break;
    }
  },

  _emitHoistedFunctionDeclarations(this: ScopeCompiler, statements: ASTNode[]) {
    for (const stmt of statements) {
      if (
        stmt.type === NodeType.FunctionDeclaration ||
        stmt.type === NodeType.LazyFunctionDeclaration
      ) {
        stmt._hoisted = true;
        if (stmt.type === NodeType.LazyFunctionDeclaration) {
          this.compileLazyFunctionDeclaration(stmt);
        } else {
          this.compileFunctionDeclaration(stmt);
        }
      }
    }
  },

  _prepareFunctionBody(this: ScopeCompiler, statements: ASTNode[]) {
    this._hoistVars(statements);
    this._prescanLocals(statements);
    this._emitHoistedFunctionDeclarations(statements);
  },
};

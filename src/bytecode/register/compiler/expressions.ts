import {
  NodeType,
  ForOfStatement,
  ExpressionStatement,
  Identifier,
  YieldExpression,
  BlockStatement,
} from "../../../frontend/ast/index.js";
import type { ASTNode } from "../../../frontend/ast/index.js";
import * as bytecode from "../ops/bytecode.js";
import type { Scope, ScopeResolution } from "./helpers.js";
import type { TempAllocator } from "./temp-allocator.js";

type ObjectPropertyNode = RuntimeRecord & {
  spread?: boolean;
  argument?: CompilerNode;
  kind?: "get" | "set" | string;
  key?: string | CompilerNode;
  value?: CompilerNode;
  computed?: boolean;
};

type CompilerNode = ASTNode &
  RuntimeRecord & {
    type: string;
    expressions: CompilerNode[];
    kind: string;
    value: RuntimeValue | CompilerNode;
    name: string;
    left: CompilerNode;
    right: CompilerNode;
    op: string;
    argument: CompilerNode | null;
    target: CompilerNode;
    object: CompilerNode;
    property: string | CompilerNode;
    computed: boolean;
    args: CompilerNode[];
    callee: CompilerNode;
    properties: ObjectPropertyNode[];
    elements: Array<CompilerNode | null>;
    test: CompilerNode;
    consequent: CompilerNode;
    alternate: CompilerNode;
    delegate?: boolean;
    parts: string[];
    prefix: boolean;
  };

type CallParts = {
  positional: CompilerNode[];
  named: Array<{ name: string; value: CompilerNode }>;
};

function requireExpressionNode(
  node: CompilerNode | null | undefined,
  context: string,
): CompilerNode {
  if (node === null || node === undefined) {
    throw new Error(`[RegCompiler] Missing expression for ${context}`);
  }
  return node;
}

function requirePropertyExpression(
  property: string | CompilerNode | undefined,
  context: string,
): CompilerNode {
  if (typeof property === "string" || property === undefined) {
    throw new Error(`[RegCompiler] Expected computed property expression for ${context}`);
  }
  return property;
}

function requireObjectKey(
  key: string | CompilerNode | undefined,
  context: string,
): string | CompilerNode {
  if (key === undefined) {
    throw new Error(`[RegCompiler] Missing object key for ${context}`);
  }
  return key;
}

function requireStringKey(key: string | CompilerNode | undefined, context: string): string {
  const next = requireObjectKey(key, context);
  if (typeof next !== "string") throw new Error(`[RegCompiler] Expected named property for ${context}`);
  return next;
}

function splitCallArgs(args: CompilerNode[]): CallParts {
  const positional: CompilerNode[] = [];
  const named: Array<{ name: string; value: CompilerNode }> = [];
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg.type !== "NamedArgument") {
      positional.push(arg);
      continue;
    }
    if (!arg.name || !isCompilerNode(arg.value)) throw new Error("[RegCompiler] Invalid named argument");
    if (seen.has(arg.name)) throw new Error(`[RegCompiler] Duplicate named argument '${arg.name}'`);
    seen.add(arg.name);
    named.push({ name: arg.name, value: arg.value });
  }
  return { positional, named };
}

function isCompilerNode(
  value: RuntimeValue | CompilerNode | null | undefined,
): value is CompilerNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function requireAssignmentValue(node: CompilerNode): CompilerNode {
  return requireExpressionNode(
    isCompilerNode(node.value) ? node.value : undefined,
    "assignment value",
  );
}

function emitLoadSuperPrototypeProperty(ctx: ExpressionCompilerThis, property: string): void {
  const className = ctx._currentSuperClassName;
  if (!className) throw new Error("[RegCompiler] super property used outside of a class method");
  const resolved = ctx.scope.resolve("_superClass$" + className);
  if (!resolved) throw new Error("[RegCompiler] Cannot resolve super class reference");
  ctx.emitLoadToAcc(resolved);
  const superReg = ctx.temps.alloc();
  ctx.func.emit(bytecode.ROP_STAR, superReg);
  const protoIdx = ctx.func.addConstant("prototype");
  const protoSlot = ctx.func.allocFeedbackSlot();
  ctx.func.emit(bytecode.ROP_LDA_PROP, superReg, protoIdx, protoSlot);
  const protoReg = ctx.temps.alloc();
  ctx.func.emit(bytecode.ROP_STAR, protoReg);
  const propIdx = ctx.func.addConstant(property);
  const propSlot = ctx.func.allocFeedbackSlot();
  ctx.func.emit(bytecode.ROP_LDA_PROP, protoReg, propIdx, propSlot);
  ctx.temps.free(protoReg);
  ctx.temps.free(superReg);
}

type ExpressionCompilerThis = {
  func: bytecode.RegisterCompiledFunction;
  scope: Scope;
  temps: TempAllocator;
  _yieldStarCount?: number;
  _currentSuperClassName?: string | null;
  compileExpression(node: CompilerNode): number | void;
  compileLiteral(node: CompilerNode): number | void;
  compileIdentifier(node: CompilerNode): number | void;
  compileBinaryExpression(node: CompilerNode): number | void;
  compileUnaryExpression(node: CompilerNode): number | void;
  compileLogicalExpression(node: CompilerNode): number | void;
  compileAssignment(node: CompilerNode): number | void;
  compileCallExpression(node: CompilerNode): number | void;
  compileNewExpression(node: CompilerNode): number | void;
  compileMemberExpression(node: CompilerNode): number | void;
  compileIndexExpression(node: CompilerNode): number | void;
  compileObjectExpression(node: CompilerNode): number | void;
  compileArrayExpression(node: CompilerNode): number | void;
  compileConditionalExpression(node: CompilerNode): number | void;
  compileAwaitExpression(node: CompilerNode): number | void;
  compileYieldExpression(node: CompilerNode): number | void;
  compileUpdateExpression(node: CompilerNode): number | void;
  compileCompoundAssignment(node: CompilerNode): number | void;
  compileArrowFunction(node: CompilerNode): number | void;
  compileFunctionExpression(node: CompilerNode): number | void;
  compileTemplateLiteral(node: CompilerNode): number | void;
  compileNullishCoalescing(node: CompilerNode): number | void;
  compileOptionalMember(node: CompilerNode): number | void;
  compileOptionalCall(node: CompilerNode): number | void;
  compileSuperCall(node: CompilerNode): number | void;
  compileSequenceExpression(node: CompilerNode): number | void;
  emitLoadToAcc(resolved: ScopeResolution): void;
  emitStoreAcc(resolved: ScopeResolution): void;
  _buildSpreadArgs(args: CompilerNode[]): number;
  compileForOfStatement(node: ASTNode): void;
};
type ExpressionMethodMap = {
  [name: string]: (this: ExpressionCompilerThis, ...args: never[]) => number | void;
} & ThisType<ExpressionCompilerThis>;

export const BINARY_OP_MAP: Record<string, bytecode.RegisterOpcode> = {
  "+": bytecode.ROP_ADD,
  "-": bytecode.ROP_SUB,
  "*": bytecode.ROP_MUL,
  "/": bytecode.ROP_DIV,
  "%": bytecode.ROP_MOD,
  "@": bytecode.ROP_MATMUL,
  "===": bytecode.ROP_EQ,
  "!==": bytecode.ROP_NEQ,
  "<": bytecode.ROP_LT,
  ">": bytecode.ROP_GT,
  "<=": bytecode.ROP_LTE,
  ">=": bytecode.ROP_GTE,
  "&": bytecode.ROP_BITAND,
  "|": bytecode.ROP_BITOR,
  "^": bytecode.ROP_BITXOR,
  "<<": bytecode.ROP_SHL,
  ">>": bytecode.ROP_SHR,
  ">>>": bytecode.ROP_USHR,
  "**": bytecode.ROP_POW,
  instanceof: bytecode.ROP_INSTANCEOF,
  in: bytecode.ROP_IN,
  "==": bytecode.ROP_LOOSE_EQ,
  "!=": bytecode.ROP_LOOSE_NEQ,
};

export const expressionMethods: ExpressionMethodMap = {
  compileExpression(node: CompilerNode) {
    switch (node.type) {
      case NodeType.Literal:
        return this.compileLiteral(node);
      case NodeType.Identifier:
        return this.compileIdentifier(node);
      case NodeType.ThisExpression:
        return this.func.emit(bytecode.ROP_LDA_THIS);
      case NodeType.SuperExpression:
        throw new Error("[RegCompiler] Bare super is not supported");
      case NodeType.BinaryExpression:
        return this.compileBinaryExpression(node);
      case NodeType.UnaryExpression:
        return this.compileUnaryExpression(node);
      case NodeType.LogicalExpression:
        return this.compileLogicalExpression(node);
      case NodeType.AssignmentExpression:
        return this.compileAssignment(node);
      case NodeType.CallExpression: {
        const emitted = this.compileCallExpression(node);
        if (node.implicitAwait) this.func.emit(bytecode.ROP_AWAIT);
        return emitted;
      }
      case NodeType.NewExpression:
        return this.compileNewExpression(node);
      case NodeType.MemberExpression:
        return this.compileMemberExpression(node);
      case NodeType.IndexExpression:
        return this.compileIndexExpression(node);
      case NodeType.ObjectExpression:
        return this.compileObjectExpression(node);
      case NodeType.ArrayExpression:
        return this.compileArrayExpression(node);
      case NodeType.ConditionalExpression:
        return this.compileConditionalExpression(node);
      case NodeType.AwaitExpression:
        return this.compileAwaitExpression(node);
      case NodeType.YieldExpression:
        return this.compileYieldExpression(node);
      case NodeType.UpdateExpression:
        return this.compileUpdateExpression(node);
      case NodeType.CompoundAssignmentExpression:
        return this.compileCompoundAssignment(node);
      case NodeType.ArrowFunctionExpression:
        return this.compileArrowFunction(node);
      case NodeType.FunctionExpression:
        return this.compileFunctionExpression(node);
      case NodeType.TemplateLiteral:
        return this.compileTemplateLiteral(node);
      case NodeType.NullishCoalescingExpression:
        return this.compileNullishCoalescing(node);
      case NodeType.OptionalMemberExpression:
        return this.compileOptionalMember(node);
      case NodeType.OptionalCallExpression:
        return this.compileOptionalCall(node);
      case NodeType.SuperCallExpression:
        return this.compileSuperCall(node);
      case NodeType.SequenceExpression:
        return this.compileSequenceExpression(node);
      default:
        throw new Error(`[RegCompiler] Unknown expression type '${node.type}'`);
    }
  },

  compileSequenceExpression(node: CompilerNode) {
    for (let i = 0; i < node.expressions.length; i++) {
      this.compileExpression(node.expressions[i]);
    }
  },

  compileLiteral(node: CompilerNode) {
    switch (node.kind) {
      case "boolean":
        return this.func.emit(
          node.value ? bytecode.ROP_LDA_TRUE : bytecode.ROP_LDA_FALSE,
        );
      case "null":
        return this.func.emit(bytecode.ROP_LDA_NULL);
      case "undefined":
        return this.func.emit(bytecode.ROP_LDA_UNDEFINED);
      case "regex": {
        const idx = this.func.addConstant(node.value);
        return this.func.emit(bytecode.ROP_NEW_REGEX, idx);
      }
      default: {
        const idx = this.func.addConstant(node.value);
        return this.func.emit(bytecode.ROP_LDA_CONST, idx);
      }
    }
  },

  emitLoadToAcc(resolved: ScopeResolution) {
    if (resolved.type === "local") {
      this.func.emit(bytecode.ROP_LDA_REG, resolved.slot);
    } else if (resolved.type === "upvalue") {
      this.func.emit(bytecode.ROP_LDA_UPVALUE, resolved.slot);
    }
  },

  emitStoreAcc(resolved: ScopeResolution) {
    if (resolved.type === "local") {
      this.func.emit(bytecode.ROP_STAR, resolved.slot);
    } else if (resolved.type === "upvalue") {
      this.func.emit(bytecode.ROP_STA_UPVALUE, resolved.slot);
    }
  },

  compileIdentifier(node: CompilerNode) {
    const resolved = this.scope.resolve(node.name);
    if (resolved !== null) {
      this.emitLoadToAcc(resolved);
    } else if (
      node.name === "arguments" &&
      !(this.scope.isInScriptScope && this.scope.isInScriptScope())
    ) {
      this.func.emit(bytecode.ROP_LOAD_ARGUMENTS);
    } else {
      const nameIdx = this.func.addConstant(node.name);
      this.func.emit(bytecode.ROP_LDA_GLOBAL, nameIdx);
    }
  },

  compileBinaryExpression(node: CompilerNode) {
    const tmp = this.temps.alloc();
    this.compileExpression(node.left);
    this.func.emit(bytecode.ROP_STAR, tmp);

    this.compileExpression(node.right);

    const tmp2 = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, tmp2);
    this.func.emit(bytecode.ROP_LDA_REG, tmp);

    const opcode = BINARY_OP_MAP[node.op];
    if (opcode === undefined) {
      throw new Error(`[RegCompiler] Unknown binary operator '${node.op}'`);
    }

    const fbSlot = this.func.allocFeedbackSlot();
    this.func.emit(opcode, tmp2, fbSlot);

    this.temps.free(tmp2);
    this.temps.free(tmp);
  },

  compileUnaryExpression(node: CompilerNode) {
    const argument = requireExpressionNode(node.argument, "unary expression");
    this.compileExpression(argument);
    switch (node.op) {
      case "!": {
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_NOT, fbSlot);
        break;
      }
      case "-": {
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_NEG, fbSlot);
        break;
      }
      case "+": {
        this.func.emit(bytecode.ROP_NEG, this.func.allocFeedbackSlot());
        this.func.emit(bytecode.ROP_NEG, this.func.allocFeedbackSlot());
        break;
      }
      case "typeof":
        this.func.emit(bytecode.ROP_TYPEOF);
        break;
      case "~": {
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_BITNOT, fbSlot);
        break;
      }
      case "void":
        this.func.emit(bytecode.ROP_VOID);
        break;
      case "delete": {
        if (argument.type === NodeType.MemberExpression) {
          var objReg = this.temps.alloc();
          this.compileExpression(argument.object);
          this.func.emit(bytecode.ROP_STAR, objReg);
          if (argument.computed) {
            var keyReg = this.temps.alloc();
            this.compileExpression(
              requirePropertyExpression(argument.property, "delete"),
            );
            this.func.emit(bytecode.ROP_STAR, keyReg);
            this.func.emit(bytecode.ROP_DELETE_PROP, objReg, 0, keyReg);
            this.temps.free(keyReg);
          } else {
            var propIdx = this.func.addConstant(argument.property);
            this.func.emit(bytecode.ROP_DELETE_PROP, objReg, propIdx);
          }
          this.temps.free(objReg);
          return;
        }
        this.func.emit(bytecode.ROP_LDA_TRUE);
        break;
      }
      default:
        throw new Error(`[RegCompiler] Unknown unary operator '${node.op}'`);
    }
  },

  compileLogicalExpression(node: CompilerNode) {
    this.compileExpression(node.left);

    if (node.op === "&&") {
      const jumpToEnd = this.func.emit(bytecode.ROP_JUMP_IF_FALSE, 0);
      this.compileExpression(node.right);
      this.func.patchJump(jumpToEnd, this.func.instructions.length);
    } else if (node.op === "||") {
      const jumpToEnd = this.func.emit(bytecode.ROP_JUMP_IF_TRUE, 0);
      this.compileExpression(node.right);
      this.func.patchJump(jumpToEnd, this.func.instructions.length);
    } else {
      throw new Error(`[RegCompiler] Unknown logical operator '${node.op}'`);
    }
  },

  compileAssignment(node: CompilerNode) {
    const target = node.target;

    if (target.type === NodeType.Identifier) {
      if (this.scope.isConst(target.name)) {
        throw new Error(`Assignment to constant variable '${target.name}'`);
      }
      this.compileExpression(requireAssignmentValue(node));

      const resolved = this.scope.resolve(target.name);
      if (resolved !== null) {
        this.emitStoreAcc(resolved);
      } else {
        const nameIdx = this.func.addConstant(target.name);
        this.func.emit(bytecode.ROP_STA_GLOBAL, nameIdx);
      }
    } else if (target.type === NodeType.MemberExpression) {
      if (typeof target.property === "string") {
        const objReg = this.temps.alloc();
        this.compileExpression(target.object);
        this.func.emit(bytecode.ROP_STAR, objReg);

        this.compileExpression(requireAssignmentValue(node));
        const propIdx = this.func.addConstant(target.property);
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_STA_PROP, objReg, propIdx, fbSlot);
        this.temps.free(objReg);
      } else {
        const objReg = this.temps.alloc();
        this.compileExpression(target.object);
        this.func.emit(bytecode.ROP_STAR, objReg);

        const idxReg = this.temps.alloc();
        this.compileExpression(target.property);
        this.func.emit(bytecode.ROP_STAR, idxReg);

        this.compileExpression(requireAssignmentValue(node));
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_STA_INDEX, objReg, idxReg, fbSlot);

        this.temps.free(idxReg);
        this.temps.free(objReg);
      }
    } else {
      throw new Error(
        `[RegCompiler] Invalid assignment target type '${target.type}'`,
      );
    }
  },

  _buildSpreadArgs(args: CompilerNode[]) {
    this.func.emit(bytecode.ROP_NEW_ARRAY, 0, 0);
    const arrReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, arrReg);
    for (const arg of args) {
      if (arg.type === NodeType.SpreadElement) {
        this.compileExpression(
          requireExpressionNode(arg.argument, "spread argument"),
        );
        this.func.emit(bytecode.ROP_SPREAD_ARRAY, arrReg);
      } else {
        this.compileExpression(arg);
        this.func.emit(bytecode.ROP_ARRAY_PUSH, arrReg);
      }
    }
    return arrReg;
  },

  compileCallExpression(node: CompilerNode) {
    const parts = splitCallArgs(node.args);
    const hasSpread = node.args.some(
      (a: CompilerNode | null) => a !== null && a.type === NodeType.SpreadElement,
    );

    if (hasSpread) {
      if (node.callee.type === NodeType.MemberExpression) {
        const recvReg = this.temps.alloc();
        if (node.callee.object.type === NodeType.SuperExpression) {
          if (node.callee.computed) throw new Error("[RegCompiler] Computed super methods are not supported");
          this.func.emit(bytecode.ROP_LDA_THIS);
          this.func.emit(bytecode.ROP_STAR, recvReg);
          emitLoadSuperPrototypeProperty(this, requireStringKey(node.callee.property, "method call"));
        } else {
          this.compileExpression(node.callee.object);
          this.func.emit(bytecode.ROP_STAR, recvReg);
          const propIdx = this.func.addConstant(
            requireObjectKey(node.callee.property, "method call"),
          );
          const propFbSlot = this.func.allocFeedbackSlot();
          this.func.emit(bytecode.ROP_LDA_PROP, recvReg, propIdx, propFbSlot);
        }
        const funcReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_STAR, funcReg);
        const argsReg = this._buildSpreadArgs(parts.positional);
        const fbSlot = this.func.allocFeedbackSlot();
        if (parts.named.length > 0) {
          const namedCount = parts.named.length;
          const firstNamedReg = this.temps.allocContiguous(namedCount);
          for (let i = 0; i < namedCount; i++) {
            this.compileExpression(parts.named[i]!.value);
            this.func.emit(bytecode.ROP_STAR, firstNamedReg + i);
          }
          const namesIdx = this.func.addConstant(parts.named.map((arg) => arg.name));
          this.func.emit(
            bytecode.ROP_CALL_METHOD_SPREAD_NAMED,
            funcReg,
            argsReg,
            recvReg,
            firstNamedReg,
            namesIdx,
            namedCount,
            fbSlot,
          );
          for (let i = namedCount - 1; i >= 0; i--) this.temps.free(firstNamedReg + i);
        } else {
          this.func.emit(
            bytecode.ROP_CALL_SPREAD,
            funcReg,
            argsReg,
            recvReg,
            fbSlot,
          );
        }
        this.temps.free(argsReg);
        this.temps.free(funcReg);
        this.temps.free(recvReg);
      } else {
        const funcReg = this.temps.alloc();
        this.compileExpression(node.callee);
        this.func.emit(bytecode.ROP_STAR, funcReg);
        const argsReg = this._buildSpreadArgs(parts.positional);
        const fbSlot = this.func.allocFeedbackSlot();
        if (parts.named.length > 0) {
          const namedCount = parts.named.length;
          const firstNamedReg = this.temps.allocContiguous(namedCount);
          for (let i = 0; i < namedCount; i++) {
            this.compileExpression(parts.named[i]!.value);
            this.func.emit(bytecode.ROP_STAR, firstNamedReg + i);
          }
          const namesIdx = this.func.addConstant(parts.named.map((arg) => arg.name));
          this.func.emit(
            bytecode.ROP_CALL_SPREAD_NAMED,
            funcReg,
            argsReg,
            firstNamedReg,
            namesIdx,
            namedCount,
            fbSlot,
          );
          for (let i = namedCount - 1; i >= 0; i--) this.temps.free(firstNamedReg + i);
        } else {
          this.func.emit(bytecode.ROP_CALL_SPREAD, funcReg, argsReg, 0, fbSlot);
        }
        this.temps.free(argsReg);
        this.temps.free(funcReg);
      }
      return;
    }

    if (node.callee.type === NodeType.MemberExpression) {
      const recvReg = this.temps.alloc();
      if (node.callee.object.type === NodeType.SuperExpression) {
        if (node.callee.computed) throw new Error("[RegCompiler] Computed super methods are not supported");
        this.func.emit(bytecode.ROP_LDA_THIS);
        this.func.emit(bytecode.ROP_STAR, recvReg);
        emitLoadSuperPrototypeProperty(this, requireStringKey(node.callee.property, "method call"));
      } else {
        this.compileExpression(node.callee.object);
        this.func.emit(bytecode.ROP_STAR, recvReg);
      }

      if (node.callee.computed && node.callee.object.type !== NodeType.SuperExpression) {
        const idxReg = this.temps.alloc();
        this.compileExpression(
          requirePropertyExpression(node.callee.property, "computed call"),
        );
        this.func.emit(bytecode.ROP_STAR, idxReg);
        const idxFbSlot = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_LDA_INDEX, recvReg, idxReg, idxFbSlot);
        this.temps.free(idxReg);
      } else if (node.callee.object.type !== NodeType.SuperExpression) {
        const propIdx = this.func.addConstant(node.callee.property);
        const propFbSlot = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_LDA_PROP, recvReg, propIdx, propFbSlot);
      }

      const methodReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, methodReg);

      const argCount = parts.positional.length;
      const firstArgReg =
        argCount > 0 ? this.temps.allocContiguous(argCount) : 0;
      for (let i = 0; i < argCount; i++) {
        this.compileExpression(parts.positional[i]!);
        this.func.emit(bytecode.ROP_STAR, firstArgReg + i);
      }

      this.func.emit(bytecode.ROP_LDA_REG, methodReg);
      const fbSlot = this.func.allocFeedbackSlot();
      if (parts.named.length > 0) {
        const namedCount = parts.named.length;
        const firstNamedReg = this.temps.allocContiguous(namedCount);
        for (let i = 0; i < namedCount; i++) {
          this.compileExpression(parts.named[i]!.value);
          this.func.emit(bytecode.ROP_STAR, firstNamedReg + i);
        }
        this.func.emit(bytecode.ROP_LDA_REG, methodReg);
        const namesIdx = this.func.addConstant(parts.named.map((arg) => arg.name));
        this.func.emit(
          bytecode.ROP_CALL_METHOD_NAMED,
          recvReg,
          firstArgReg,
          argCount,
          firstNamedReg,
          namesIdx,
          namedCount,
          fbSlot,
        );
        for (let i = namedCount - 1; i >= 0; i--) this.temps.free(firstNamedReg + i);
      } else {
        this.func.emit(
          bytecode.ROP_CALL_METHOD,
          recvReg,
          firstArgReg,
          argCount,
          fbSlot,
        );
      }

      for (let i = argCount - 1; i >= 0; i--) this.temps.free(firstArgReg + i);
      this.temps.free(methodReg);
      this.temps.free(recvReg);
    } else {
      const funcReg = this.temps.alloc();
      this.compileExpression(node.callee);
      this.func.emit(bytecode.ROP_STAR, funcReg);

      const argCount = parts.positional.length;
      const firstArgReg =
        argCount > 0 ? this.temps.allocContiguous(argCount) : 0;
      for (let i = 0; i < argCount; i++) {
        this.compileExpression(parts.positional[i]!);
        this.func.emit(bytecode.ROP_STAR, firstArgReg + i);
      }

      const fbSlot = this.func.allocFeedbackSlot();
      if (parts.named.length > 0) {
        const namedCount = parts.named.length;
        const firstNamedReg = this.temps.allocContiguous(namedCount);
        for (let i = 0; i < namedCount; i++) {
          this.compileExpression(parts.named[i]!.value);
          this.func.emit(bytecode.ROP_STAR, firstNamedReg + i);
        }
        const namesIdx = this.func.addConstant(parts.named.map((arg) => arg.name));
        this.func.emit(
          bytecode.ROP_CALL_NAMED,
          funcReg,
          firstArgReg,
          argCount,
          firstNamedReg,
          namesIdx,
          namedCount,
          fbSlot,
        );
        for (let i = namedCount - 1; i >= 0; i--) this.temps.free(firstNamedReg + i);
      } else {
        this.func.emit(
          bytecode.ROP_CALL,
          funcReg,
          firstArgReg,
          argCount,
          fbSlot,
        );
      }

      for (let i = argCount - 1; i >= 0; i--) this.temps.free(firstArgReg + i);
      this.temps.free(funcReg);
    }
  },

  compileNewExpression(node: CompilerNode) {
    const funcReg = this.temps.alloc();
    this.compileExpression(node.callee);
    this.func.emit(bytecode.ROP_STAR, funcReg);

    const argCount = node.args.length;
    const firstArgReg =
      argCount > 0 ? this.temps.allocContiguous(argCount) : 0;
    for (let i = 0; i < argCount; i++) {
      this.compileExpression(node.args[i]!);
      this.func.emit(bytecode.ROP_STAR, firstArgReg + i);
    }

    this.func.emit(bytecode.ROP_NEW, funcReg, firstArgReg, argCount);

    for (let i = argCount - 1; i >= 0; i--) this.temps.free(firstArgReg + i);
    this.temps.free(funcReg);
  },

  compileMemberExpression(node: CompilerNode) {
    if (node.object.type === NodeType.SuperExpression) {
      if (node.computed) throw new Error("[RegCompiler] Computed super properties are not supported");
      emitLoadSuperPrototypeProperty(this, requireStringKey(node.property, "super property"));
      return;
    }
    const objReg = this.temps.alloc();
    this.compileExpression(node.object);
    this.func.emit(bytecode.ROP_STAR, objReg);

    if (typeof node.property === "string") {
      const propIdx = this.func.addConstant(node.property);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_PROP, objReg, propIdx, fbSlot);
    } else {
      const idxReg = this.temps.alloc();
      this.compileExpression(node.property);
      this.func.emit(bytecode.ROP_STAR, idxReg);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_INDEX, objReg, idxReg, fbSlot);
      this.temps.free(idxReg);
    }
    this.temps.free(objReg);
  },

  compileIndexExpression(node: CompilerNode) {
    const objReg = this.temps.alloc();
    this.compileExpression(node.object);
    this.func.emit(bytecode.ROP_STAR, objReg);

    const tokens: string[] = [];
    const boundRegs: number[] = [];
    const compileInto = (expr: CompilerNode) => {
      const reg = this.temps.alloc();
      this.compileExpression(expr);
      this.func.emit(bytecode.ROP_STAR, reg);
      boundRegs.push(reg);
    };

    for (const dim of node.dims as CompilerNode[]) {
      if (dim.kind === "index") {
        compileInto(dim.value as CompilerNode);
        tokens.push("i");
        continue;
      }
      const hasStart = dim.start ? 1 : 0;
      const hasStop = dim.stop ? 1 : 0;
      const hasStep = dim.step ? 1 : 0;
      if (dim.start) compileInto(dim.start as CompilerNode);
      if (dim.stop) compileInto(dim.stop as CompilerNode);
      if (dim.step) compileInto(dim.step as CompilerNode);
      tokens.push(`s${hasStart}${hasStop}${hasStep}`);
    }

    const descIdx = this.func.addConstant(tokens);
    this.func.emit(bytecode.ROP_LDA_KEYED_SLICE, objReg, descIdx, ...boundRegs);
    for (let i = boundRegs.length - 1; i >= 0; i--) this.temps.free(boundRegs[i]!);
    this.temps.free(objReg);
  },

  compileObjectExpression(node: CompilerNode) {
    this.func.emit(bytecode.ROP_NEW_OBJECT);

    if (node.properties.length > 0) {
      const objReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, objReg);

      for (const prop of node.properties) {
        if (prop.spread) {
          this.compileExpression(
            requireExpressionNode(prop.argument, "object spread"),
          );
          this.func.emit(bytecode.ROP_COPY_PROPS, objReg);
        } else if (prop.kind === "get" || prop.kind === "set") {
          this.compileExpression(
            requireExpressionNode(prop.value, "object accessor"),
          );
          const fnReg = this.temps.alloc();
          this.func.emit(bytecode.ROP_STAR, fnReg);
          const propIdx = this.func.addConstant(
            requireObjectKey(prop.key, "object accessor"),
          );
          const getterReg = prop.kind === "get" ? fnReg : -1;
          const setterReg = prop.kind === "set" ? fnReg : -1;
          this.func.emit(
            bytecode.ROP_DEFINE_ACCESSOR,
            objReg,
            propIdx,
            getterReg,
            setterReg,
          );
          this.temps.free(fnReg);
        } else if (prop.computed) {
          const keyReg = this.temps.alloc();
          this.compileExpression(
            requirePropertyExpression(prop.key, "computed object property"),
          );
          this.func.emit(bytecode.ROP_STAR, keyReg);
          this.compileExpression(
            requireExpressionNode(prop.value, "computed object property value"),
          );
          this.func.emit(bytecode.ROP_STA_COMPUTED_PROP, objReg, keyReg);
          this.temps.free(keyReg);
        } else {
          this.compileExpression(
            requireExpressionNode(prop.value, "object property value"),
          );
          const propIdx = this.func.addConstant(
            requireObjectKey(prop.key, "object property"),
          );
          const fbSlot = this.func.allocFeedbackSlot();
          this.func.emit(bytecode.ROP_STA_PROP, objReg, propIdx, fbSlot);
        }
      }

      this.func.emit(bytecode.ROP_LDA_REG, objReg);
      this.temps.free(objReg);
    }
  },

  compileArrayExpression(node: CompilerNode) {
    const hasSpread = node.elements.some(
      (e: CompilerNode | null) => e !== null && e.type === NodeType.SpreadElement,
    );

    if (!hasSpread) {
      const count = node.elements.length;
      const firstReg = count > 0 ? this.temps.allocContiguous(count) : 0;
      for (let i = 0; i < count; i++) {
        if (node.elements[i] === null) {
          this.func.emit(bytecode.ROP_LDA_UNDEFINED);
        } else {
          this.compileExpression(node.elements[i]!);
        }
        this.func.emit(bytecode.ROP_STAR, firstReg + i);
      }
      this.func.emit(bytecode.ROP_NEW_ARRAY, firstReg, count);
      for (let i = count - 1; i >= 0; i--) this.temps.free(firstReg + i);
    } else {
      this.func.emit(bytecode.ROP_NEW_ARRAY, 0, 0);
      const arrReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, arrReg);
      for (const elem of node.elements) {
        if (elem === null) {
          this.func.emit(bytecode.ROP_LDA_UNDEFINED);
          this.func.emit(bytecode.ROP_ARRAY_PUSH, arrReg);
        } else if (elem.type === NodeType.SpreadElement) {
          this.compileExpression(
            requireExpressionNode(elem.argument, "spread element"),
          );
          this.func.emit(bytecode.ROP_SPREAD_ARRAY, arrReg);
        } else {
          this.compileExpression(elem);
          this.func.emit(bytecode.ROP_ARRAY_PUSH, arrReg);
        }
      }
      this.func.emit(bytecode.ROP_LDA_REG, arrReg);
      this.temps.free(arrReg);
    }
  },

  compileConditionalExpression(node: CompilerNode) {
    this.compileExpression(node.test);
    const jumpToElse = this.func.emit(bytecode.ROP_JUMP_IF_FALSE, 0);
    this.compileExpression(node.consequent);
    const jumpToEnd = this.func.emit(bytecode.ROP_JUMP, 0);
    this.func.patchJump(jumpToElse, this.func.instructions.length);
    this.compileExpression(node.alternate);
    this.func.patchJump(jumpToEnd, this.func.instructions.length);
  },

  compileAwaitExpression(node: CompilerNode) {
    this.compileExpression(requireExpressionNode(node.argument, "await"));
    this.func.emit(bytecode.ROP_AWAIT);
  },

  compileYieldExpression(node: CompilerNode) {
    if (node.delegate) {
      this._yieldStarCount = (this._yieldStarCount || 0) + 1;
      const varName = "_yieldStar$" + this._yieldStarCount;
      const loop = ForOfStatement(
        varName,
        requireExpressionNode(node.argument, "yield*"),
        BlockStatement([
          ExpressionStatement(YieldExpression(Identifier(varName), false)),
        ]),
        "let",
      );
      this.compileForOfStatement(loop);
      this.func.emit(bytecode.ROP_LDA_UNDEFINED);
      return;
    }
    if (node.argument) {
      this.compileExpression(node.argument);
    } else {
      this.func.emit(bytecode.ROP_LDA_UNDEFINED);
    }
    this.func.emit(bytecode.ROP_YIELD);
  },

  compileTemplateLiteral(node: CompilerNode) {
    const resultReg = this.temps.alloc();
    const idx = this.func.addConstant(node.parts[0]);
    this.func.emit(bytecode.ROP_LDA_CONST, idx);
    this.func.emit(bytecode.ROP_STAR, resultReg);

    for (let i = 0; i < node.expressions.length; i++) {
      this.compileExpression(node.expressions[i]!);
      const exprReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, exprReg);
      this.func.emit(bytecode.ROP_LDA_REG, resultReg);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_ADD, exprReg, fbSlot);
      this.temps.free(exprReg);

      if (node.parts[i + 1] !== "") {
        const partReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_STAR, partReg);
        const partIdx = this.func.addConstant(node.parts[i + 1]);
        this.func.emit(bytecode.ROP_LDA_CONST, partIdx);
        const partExprReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_STAR, partExprReg);
        this.func.emit(bytecode.ROP_LDA_REG, partReg);
        const fbSlot2 = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_ADD, partExprReg, fbSlot2);
        this.temps.free(partExprReg);
        this.temps.free(partReg);
      }

      this.func.emit(bytecode.ROP_STAR, resultReg);
    }

    this.func.emit(bytecode.ROP_LDA_REG, resultReg);
    this.temps.free(resultReg);
  },

  compileNullishCoalescing(node: CompilerNode) {
    this.compileExpression(node.left);
    const leftReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, leftReg);
    this.func.emit(bytecode.ROP_IS_NULLISH);
    const jumpToRight = this.func.emit(bytecode.ROP_JUMP_IF_TRUE, 0);
    this.func.emit(bytecode.ROP_LDA_REG, leftReg);
    const jumpToEnd = this.func.emit(bytecode.ROP_JUMP, 0);
    this.func.patchJump(jumpToRight, this.func.instructions.length);
    this.compileExpression(node.right);
    this.func.patchJump(jumpToEnd, this.func.instructions.length);
    this.temps.free(leftReg);
  },

  compileOptionalMember(node: CompilerNode) {
    this.compileExpression(node.object);
    const objReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, objReg);
    this.func.emit(bytecode.ROP_IS_NULLISH);
    const jumpToUndef = this.func.emit(bytecode.ROP_JUMP_IF_TRUE, 0);
    this.func.emit(bytecode.ROP_LDA_REG, objReg);
    if (typeof node.property === "string") {
      const propIdx = this.func.addConstant(node.property);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_PROP, objReg, propIdx, fbSlot);
    } else {
      this.compileExpression(node.property);
      const idxReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, idxReg);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_INDEX, objReg, idxReg, fbSlot);
      this.temps.free(idxReg);
    }
    const jumpToEnd = this.func.emit(bytecode.ROP_JUMP, 0);
    this.func.patchJump(jumpToUndef, this.func.instructions.length);
    this.func.emit(bytecode.ROP_LDA_UNDEFINED);
    this.func.patchJump(jumpToEnd, this.func.instructions.length);
    this.temps.free(objReg);
  },

  compileOptionalCall(node: CompilerNode) {
    this.compileExpression(node.callee);
    const calleeReg = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, calleeReg);
    this.func.emit(bytecode.ROP_IS_NULLISH);
    const jumpToUndef = this.func.emit(bytecode.ROP_JUMP_IF_TRUE, 0);

    const argRegs: number[] = [];
    const firstArgReg = node.args.length > 0 ? this.temps.alloc() : 0;
    for (let i = 0; i < node.args.length; i++) {
      const reg = i === 0 ? firstArgReg : this.temps.alloc();
      argRegs.push(reg);
      this.compileExpression(node.args[i]!);
      this.func.emit(bytecode.ROP_STAR, reg);
    }
    const fbSlot = this.func.allocFeedbackSlot();
    this.func.emit(
      bytecode.ROP_CALL,
      calleeReg,
      firstArgReg,
      node.args.length,
      fbSlot,
    );
    for (let i = argRegs.length - 1; i >= 0; i--) this.temps.free(argRegs[i]);

    const jumpToEnd = this.func.emit(bytecode.ROP_JUMP, 0);
    this.func.patchJump(jumpToUndef, this.func.instructions.length);
    this.func.emit(bytecode.ROP_LDA_UNDEFINED);
    this.func.patchJump(jumpToEnd, this.func.instructions.length);
    this.temps.free(calleeReg);
  },

  compileUpdateExpression(node: CompilerNode) {
    const argument = requireExpressionNode(node.argument, "update expression");
    if (argument.type === NodeType.Identifier) {
      const resolved = this.scope.resolve(argument.name);
      if (resolved !== null) {
        this.emitLoadToAcc(resolved);
      } else {
        const nameIdx = this.func.addConstant(argument.name);
        this.func.emit(bytecode.ROP_LDA_GLOBAL, nameIdx);
      }

      if (!node.prefix) {
        const origReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_STAR, origReg);

        const oneReg = this.temps.alloc();
        const oneIdx = this.func.addConstant(1);
        this.func.emit(bytecode.ROP_LDA_CONST, oneIdx);
        this.func.emit(bytecode.ROP_STAR, oneReg);
        this.func.emit(bytecode.ROP_LDA_REG, origReg);
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(
          node.op === "++" ? bytecode.ROP_ADD : bytecode.ROP_SUB,
          oneReg,
          fbSlot,
        );

        if (resolved !== null) {
          this.emitStoreAcc(resolved);
        } else {
          const nameIdx = this.func.addConstant(argument.name);
          this.func.emit(bytecode.ROP_STA_GLOBAL, nameIdx);
        }
        this.func.emit(bytecode.ROP_LDA_REG, origReg);
        this.temps.free(oneReg);
        this.temps.free(origReg);
      } else {
        const tmpReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_STAR, tmpReg);
        const oneReg = this.temps.alloc();
        const oneIdx = this.func.addConstant(1);
        this.func.emit(bytecode.ROP_LDA_CONST, oneIdx);
        this.func.emit(bytecode.ROP_STAR, oneReg);
        this.func.emit(bytecode.ROP_LDA_REG, tmpReg);
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(
          node.op === "++" ? bytecode.ROP_ADD : bytecode.ROP_SUB,
          oneReg,
          fbSlot,
        );

        if (resolved !== null) {
          this.emitStoreAcc(resolved);
        } else {
          const nameIdx = this.func.addConstant(argument.name);
          this.func.emit(bytecode.ROP_STA_GLOBAL, nameIdx);
        }
        this.temps.free(oneReg);
        this.temps.free(tmpReg);
      }
    } else if (argument.type === NodeType.MemberExpression) {
      const objReg = this.temps.alloc();
      this.compileExpression(argument.object);
      this.func.emit(bytecode.ROP_STAR, objReg);

      if (typeof argument.property === "string") {
        const propIdx = this.func.addConstant(argument.property);
        const loadFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_LDA_PROP, objReg, propIdx, loadFb);
      } else {
        const idxReg = this.temps.alloc();
        this.compileExpression(argument.property);
        this.func.emit(bytecode.ROP_STAR, idxReg);
        const loadFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_LDA_INDEX, objReg, idxReg, loadFb);
        this.temps.free(idxReg);
      }

      const origReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, origReg);

      const oneReg = this.temps.alloc();
      const oneIdx = this.func.addConstant(1);
      this.func.emit(bytecode.ROP_LDA_CONST, oneIdx);
      this.func.emit(bytecode.ROP_STAR, oneReg);
      this.func.emit(bytecode.ROP_LDA_REG, origReg);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(
        node.op === "++" ? bytecode.ROP_ADD : bytecode.ROP_SUB,
        oneReg,
        fbSlot,
      );

      if (typeof argument.property === "string") {
        const propIdx = this.func.addConstant(argument.property);
        const storeFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_STA_PROP, objReg, propIdx, storeFb);
      } else {
        const idxReg = this.temps.alloc();
        this.compileExpression(argument.property);
        this.func.emit(bytecode.ROP_STAR, idxReg);
        const storeFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_STA_INDEX, objReg, idxReg, storeFb);
        this.temps.free(idxReg);
      }

      if (!node.prefix) {
        this.func.emit(bytecode.ROP_LDA_REG, origReg);
      }
      this.temps.free(oneReg);
      this.temps.free(origReg);
      this.temps.free(objReg);
    }
  },

  compileCompoundAssignment(node: CompilerNode) {
    const opcode = BINARY_OP_MAP[node.op];
    if (opcode === undefined) {
      throw new Error(
        `[RegCompiler] Unknown compound assignment operator '${node.op}='`,
      );
    }

    if (node.target.type === NodeType.Identifier) {
      const resolved = this.scope.resolve(node.target.name);

      const rhsReg = this.temps.alloc();
      this.compileExpression(requireAssignmentValue(node));
      this.func.emit(bytecode.ROP_STAR, rhsReg);

      if (resolved !== null) {
        this.emitLoadToAcc(resolved);
      } else {
        const nameIdx = this.func.addConstant(node.target.name);
        this.func.emit(bytecode.ROP_LDA_GLOBAL, nameIdx);
      }

      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(opcode, rhsReg, fbSlot);

      if (resolved !== null) {
        this.emitStoreAcc(resolved);
      } else {
        const nameIdx = this.func.addConstant(node.target.name);
        this.func.emit(bytecode.ROP_STA_GLOBAL, nameIdx);
      }
      this.temps.free(rhsReg);
    } else if (node.target.type === NodeType.MemberExpression) {
      const objReg = this.temps.alloc();
      this.compileExpression(node.target.object);
      this.func.emit(bytecode.ROP_STAR, objReg);

      if (typeof node.target.property === "string") {
        const propIdx = this.func.addConstant(node.target.property);
        const loadFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_LDA_PROP, objReg, propIdx, loadFb);

        const curReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_STAR, curReg);

        const rhsReg = this.temps.alloc();
        this.compileExpression(requireAssignmentValue(node));
        this.func.emit(bytecode.ROP_STAR, rhsReg);

        this.func.emit(bytecode.ROP_LDA_REG, curReg);
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(opcode, rhsReg, fbSlot);

        const storeFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_STA_PROP, objReg, propIdx, storeFb);

        this.temps.free(rhsReg);
        this.temps.free(curReg);
      } else {
        const idxReg = this.temps.alloc();
        this.compileExpression(node.target.property);
        this.func.emit(bytecode.ROP_STAR, idxReg);

        const loadFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_LDA_INDEX, objReg, idxReg, loadFb);

        const curReg = this.temps.alloc();
        this.func.emit(bytecode.ROP_STAR, curReg);

        const rhsReg = this.temps.alloc();
        this.compileExpression(requireAssignmentValue(node));
        this.func.emit(bytecode.ROP_STAR, rhsReg);

        this.func.emit(bytecode.ROP_LDA_REG, curReg);
        const fbSlot = this.func.allocFeedbackSlot();
        this.func.emit(opcode, rhsReg, fbSlot);

        const storeFb = this.func.allocFeedbackSlot();
        this.func.emit(bytecode.ROP_STA_INDEX, objReg, idxReg, storeFb);

        this.temps.free(rhsReg);
        this.temps.free(curReg);
        this.temps.free(idxReg);
      }
      this.temps.free(objReg);
    }
  },
};

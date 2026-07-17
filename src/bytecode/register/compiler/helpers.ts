import * as bytecode from "../ops/bytecode.js";
import type {
  LocalBindingKind,
  RegisterCompiledFunction,
  RegisterInstruction,
} from "../ops/bytecode.js";

type ConstructorSource =
  | { kind: "local"; index: number }
  | { kind: "const"; index: number }
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "true" }
  | { kind: "false" };

export type SimpleConstructorField = {
  name: string;
  source: ConstructorSource;
};

type SimpleConstructorInfo = SimpleConstructorField[] | null;

type AnalyzableFunction = RegisterCompiledFunction & {
  simpleConstructorInfo?: SimpleConstructorInfo;
};

export type ScopeBindingKind = LocalBindingKind | "function";

type ScopeBinding = {
  kind: ScopeBindingKind;
};

export type ScopeResolution = {
  type: "local" | "upvalue";
  slot: number;
  kind?: ScopeBindingKind;
  scope?: Scope;
};

function numericOperand(instr: RegisterInstruction, index: number): number | null {
  const operand = instr.operands[index];
  return typeof operand === "number" ? operand : null;
}

function analyzeConstructor(
  compiledFn: RegisterCompiledFunction,
): SimpleConstructorInfo {
  const fields: SimpleConstructorField[] = [];
  const instrs = compiledFn.instructions;
  let pc = 0;
  while (pc < instrs.length) {
    const a = instrs[pc];
    if (
      a &&
      a.opcode === bytecode.ROP_LDA_UNDEFINED &&
      instrs[pc + 1] &&
      instrs[pc + 1]!.opcode === bytecode.ROP_RETURN &&
      pc + 2 === instrs.length
    ) {
      return fields.length > 0 ? fields : null;
    }
    const b = instrs[pc + 1];
    const c = instrs[pc + 2];
    const d = instrs[pc + 3];
    if (
      !a ||
      !b ||
      !c ||
      !d ||
      a.opcode !== bytecode.ROP_LDA_THIS ||
      b.opcode !== bytecode.ROP_STAR
    ) {
      return null;
    }

    let source: ConstructorSource;
    if (c.opcode === bytecode.ROP_LDA_REG) {
      const index = numericOperand(c, 0);
      if (index === null) return null;
      source = { kind: "local", index };
    } else if (c.opcode === bytecode.ROP_LDA_CONST) {
      const index = numericOperand(c, 0);
      if (index === null) return null;
      source = { kind: "const", index };
    } else if (c.opcode === bytecode.ROP_LDA_UNDEFINED) {
      source = { kind: "undefined" };
    } else if (c.opcode === bytecode.ROP_LDA_NULL) {
      source = { kind: "null" };
    } else if (c.opcode === bytecode.ROP_LDA_TRUE) {
      source = { kind: "true" };
    } else if (c.opcode === bytecode.ROP_LDA_FALSE) {
      source = { kind: "false" };
    } else {
      return null;
    }

    if (d.opcode !== bytecode.ROP_STA_PROP) return null;
    const propNameIdx = numericOperand(d, 1);
    if (propNameIdx === null) return null;
    const name = compiledFn.constants[propNameIdx];
    if (typeof name !== "string" || fields.some((f) => f.name === name)) {
      return null;
    }
    fields.push({ name, source });
    pc += 4;
  }
  return fields.length > 0 ? fields : null;
}

export function analyzeSimpleConstructor(
  compiledFn: AnalyzableFunction,
): SimpleConstructorInfo {
  if (compiledFn.simpleConstructorInfo !== undefined) {
    return compiledFn.simpleConstructorInfo;
  }
  const instrs = compiledFn.instructions;
  if (!instrs || instrs.length === 0) {
    compiledFn.simpleConstructorInfo = null;
    return null;
  }
  compiledFn.simpleConstructorInfo = analyzeConstructor(compiledFn);
  return compiledFn.simpleConstructorInfo;
}

export class Scope {
  parent: Scope | null;
  locals: Map<string, number>;
  bindings: Map<string, ScopeBinding>;
  constSlots: Set<number>;
  isFunctionBoundary: boolean;
  isScript?: boolean;
  upvalues: Array<{
    name: string;
    outerType: ScopeResolution["type"];
    outerSlot: number;
    kind: ScopeBindingKind;
  }>;
  upvalueMap: Map<string, number>;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
    this.locals = new Map();
    this.bindings = new Map();
    this.constSlots = new Set();
    this.isFunctionBoundary = false;
    this.upvalues = [];
    this.upvalueMap = new Map();
  }

  isInScriptScope(): boolean {
    let scope: Scope | null = this;
    while (scope) {
      if (scope.isScript) return true;
      if (scope.isFunctionBoundary) return false;
      scope = scope.parent;
    }
    return false;
  }

  resolve(name: string): ScopeResolution | null {
    if (this.locals.has(name)) {
      const binding = this.bindings.get(name);
      return {
        type: "local",
        slot: this.locals.get(name)!,
        kind: binding?.kind || "let",
        scope: this,
      };
    }
    if (this.parent) {
      const result = this.parent.resolve(name);
      if (result && this.isFunctionBoundary) {
        if (result.type === "local" || result.type === "upvalue") {
          return this.captureUpvalue(name, result);
        }
      }
      return result;
    }
    return null;
  }

  captureUpvalue(
    name: string,
    outerResult: ScopeResolution,
  ): ScopeResolution {
    if (this.upvalueMap.has(name)) {
      return { type: "upvalue", slot: this.upvalueMap.get(name)! };
    }
    const idx = this.upvalues.length;
    this.upvalues.push({
      name,
      outerType: outerResult.type,
      outerSlot: outerResult.slot,
      kind: outerResult.kind || "let",
    });
    this.upvalueMap.set(name, idx);
    return { type: "upvalue", slot: idx };
  }

  define(name: string, slot: number): void {
    this.locals.set(name, slot);
    this.bindings.set(name, { kind: "let" });
  }

  defineVar(name: string, slot: number): void {
    this.locals.set(name, slot);
    this.bindings.set(name, { kind: "var" });
  }

  defineFunction(name: string, slot: number): void {
    this.locals.set(name, slot);
    this.bindings.set(name, { kind: "function" });
  }

  defineConst(name: string, slot: number): void {
    this.locals.set(name, slot);
    this.bindings.set(name, { kind: "const" });
    this.constSlots.add(slot);
  }

  isConst(name: string): boolean {
    const resolved = this.resolve(name);
    if (!resolved) return false;
    if (resolved.kind === "const") return true;
    if (resolved.type !== "local") return false;

    let scope: Scope | null = this;
    while (scope) {
      if (scope.locals.has(name)) {
        return scope.constSlots.has(scope.locals.get(name)!);
      }
      if (scope.isFunctionBoundary) break;
      scope = scope.parent;
    }
    return false;
  }
}

import { getTag, toDisplayString } from "../core/value/index.js";
import type { TaggedValue } from "../core/value/index.js";
import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";

type CompiledFunctionLike = RegisterCompiledFunction;

type IRNodeLike = {
  id?: number;
  type?: string;
  name?: string | null;
};

export type FrameValue =
  | RuntimeValue
  | IRNodeLike;
type SunkAllocations = Map<FrameValue, FrameValue>;

export class FrameState {
  compiledFunction: CompiledFunctionLike | null;
  bytecodeOffset: number;
  localValues: Map<number, FrameValue>;
  stackValues: FrameValue[];
  thisValue: FrameValue | null;
  id: number;
  callerFrameState: FrameState | null;
  isInlinedFrame: boolean;
  safepoint: boolean;
  sunkAllocations: SunkAllocations | null;

  constructor(
    compiledFunction: CompiledFunctionLike | null,
    bytecodeOffset: number,
  ) {
    this.compiledFunction = compiledFunction;
    this.bytecodeOffset = bytecodeOffset;
    this.localValues = new Map();
    this.stackValues = [];
    this.thisValue = null;
    this.id = -1;
    this.callerFrameState = null;
    this.isInlinedFrame = false;
    this.safepoint = false;
    this.sunkAllocations = null;
  }

  setLocal(slot: number, value: FrameValue): void {
    this.localValues.set(slot, value);
  }

  getLocal(slot: number): FrameValue | undefined {
    return this.localValues.get(slot);
  }

  hasLocal(slot: number): boolean {
    return this.localValues.has(slot);
  }

  pushStack(value: FrameValue): void {
    this.stackValues.push(value);
  }

  popStack(): FrameValue | undefined {
    return this.stackValues.pop();
  }

  peekStack(): FrameValue | undefined {
    return this.stackValues[this.stackValues.length - 1];
  }

  setThis(value: FrameValue): void {
    this.thisValue = value;
  }

  setCallerFrame(callerFS: FrameState): void {
    this.callerFrameState = callerFS;
    this.isInlinedFrame = true;
  }

  markAsSafepoint(): void {
    this.safepoint = true;
  }

  setSunkAllocations(sunkAllocs: SunkAllocations): void {
    this.sunkAllocations = sunkAllocs;
  }

  clone(): FrameState {
    const fs = new FrameState(this.compiledFunction, this.bytecodeOffset);
    for (const [k, v] of this.localValues) {
      fs.localValues.set(k, v);
    }
    fs.stackValues = [...this.stackValues];
    fs.thisValue = this.thisValue;
    fs.id = this.id;
    fs.callerFrameState = this.callerFrameState;
    fs.isInlinedFrame = this.isInlinedFrame;
    fs.safepoint = this.safepoint;
    fs.sunkAllocations = this.sunkAllocations
      ? new Map(this.sunkAllocations)
      : null;
    return fs;
  }

  setBytecodeOffset(offset: number): void {
    this.bytecodeOffset = offset;
  }

  get localCount(): number {
    return this.localValues.size;
  }

  get stackDepth(): number {
    return this.stackValues.length;
  }

  get functionName(): string {
    return this.compiledFunction?.name || "<anonymous>";
  }

  getLocalsArray(): Array<FrameValue | null> {
    const result: Array<FrameValue | null> = [];
    const maxSlot = Math.max(...this.localValues.keys(), -1);
    for (let i = 0; i <= maxSlot; i++) {
      result.push(this.localValues.get(i) || null);
    }
    return result;
  }

  getInlineChain(): FrameState[] {
    const chain: FrameState[] = [this];
    let current = this.callerFrameState;
    while (current) {
      chain.push(current);
      current = current.callerFrameState;
    }
    return chain;
  }

  getInlineDepth(): number {
    let depth = 0;
    let current = this.callerFrameState;
    while (current) {
      depth++;
      current = current.callerFrameState;
    }
    return depth;
  }

  matches(other: FrameState): boolean {
    if (this.compiledFunction !== other.compiledFunction) return false;
    if (this.bytecodeOffset !== other.bytecodeOffset) return false;
    if (this.localValues.size !== other.localValues.size) return false;
    for (const [key, val] of this.localValues) {
      if (!other.localValues.has(key)) return false;
      const otherVal = other.localValues.get(key);
      if (val !== otherVal) return false;
    }
    if (this.stackValues.length !== other.stackValues.length) return false;
    for (let i = 0; i < this.stackValues.length; i++) {
      if (this.stackValues[i] !== other.stackValues[i]) return false;
    }
    return true;
  }

  toCompact(): string {
    const fnName = this.functionName;
    const localCount = this.localValues.size;
    const stackDepth = this.stackValues.length;
    const inline = this.isInlinedFrame ? " [inlined]" : "";
    const sp = this.safepoint ? " [safepoint]" : "";
    return `fs#${this.id} ${fnName}@bc:${this.bytecodeOffset} L=${localCount} S=${stackDepth}${inline}${sp}`;
  }

  toString(): string {
    const fnName = this.functionName;
    const locals: string[] = [];
    const sortedKeys = [...this.localValues.keys()].sort((a, b) => a - b);
    for (const slot of sortedKeys) {
      const val = this.localValues.get(slot);
      const valStr = formatIRValue(val);
      const name = this.compiledFunction?.localNames?.[slot] || `L${slot}`;
      locals.push(`${name}=${valStr}`);
    }
    const stackStr = this.stackValues.map((v) => formatIRValue(v)).join(", ");
    const callerStr = this.callerFrameState
      ? ` caller=fs#${this.callerFrameState.id}`
      : "";
    const spStr = this.safepoint ? " [safepoint]" : "";

    return (
      `FrameState#${this.id}(fn=${fnName}, pc=${this.bytecodeOffset}, ` +
      `locals=[${locals.join(", ")}], stack=[${stackStr}]${callerStr}${spStr})`
    );
  }
}

function isIRNodeLike(val: FrameValue): val is Required<IRNodeLike> {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as IRNodeLike).id !== undefined &&
    (val as IRNodeLike).type !== undefined
  );
}

function formatIRValue(val: FrameValue): string {
  if (val === null || val === undefined) return "null";
  if (isIRNodeLike(val)) {
    return `v${String(val.id)}`;
  }
  if (typeof val === "number") {
    const tag = getTag(val as TaggedValue);
    if (tag === "string") return `"${toDisplayString(val as TaggedValue)}"`;
    if (tag === "null") return "null";
    if (tag === "undefined") return "undefined";
    if (tag === "smi" || tag === "double" || tag === "bool") {
      return toDisplayString(val as TaggedValue);
    }
    return `<${tag}>`;
  }
  return String(val);
}

export class FrameStateBuilder {
  states: FrameState[];

  constructor() {
    this.states = [];
  }

  capture(
    compiledFunction: CompiledFunctionLike | null,
    bytecodeOffset: number,
    locals?: Map<number, FrameValue> | FrameValue[] | null,
    stack?: FrameValue[] | null,
    thisValue?: FrameValue | null,
    callerFS?: FrameState | null,
  ): FrameState {
    const fs = new FrameState(compiledFunction, bytecodeOffset);

    if (locals instanceof Map) {
      for (const [slot, node] of locals) {
        fs.setLocal(slot, node);
      }
    } else if (Array.isArray(locals)) {
      for (let i = 0; i < locals.length; i++) {
        if (locals[i] !== undefined && locals[i] !== null) {
          fs.setLocal(i, locals[i]);
        }
      }
    }

    if (Array.isArray(stack)) {
      for (const node of stack) {
        fs.pushStack(node);
      }
    }

    if (thisValue !== undefined && thisValue !== null) {
      fs.setThis(thisValue);
    }

    if (callerFS) {
      fs.setCallerFrame(callerFS);
    }

    fs.id = this.states.length;
    this.states.push(fs);
    return fs;
  }

  getState(id: number): FrameState | null {
    return this.states[id] || null;
  }

  get count(): number {
    return this.states.length;
  }

  dump(): string {
    const lines = [`FrameStates (${this.states.length}):`];
    for (const fs of this.states) {
      lines.push(`  ${fs.toCompact()}`);
    }
    return lines.join("\n");
  }
}

import { CODE_UNDEFINED } from "../../../core/value/index.js";
import type { TaggedValue } from "../../../core/value/index.js";
import { Environment, UpvalueCell } from "../../../runtime/intrinsics/environment.js";
import { VMReferenceError } from "../../../core/errors/index.js";
import type { RegisterCompiledFunction } from "../ops/bytecode.js";

export type TDZUninitialized = { kind: "tdz-uninitialized" };
export type RegisterValue = TaggedValue | TDZUninitialized;
export type ExceptionHandlerRecord = {
  catchPC?: number;
  finallyPC?: number;
  endPC?: number;
  stackDepth?: number;
};

export const TDZ_UNINITIALIZED: TDZUninitialized = { kind: "tdz-uninitialized" };

export function isTDZUninitialized(value: RuntimeValue): value is TDZUninitialized {
  return value === TDZ_UNINITIALIZED;
}

export function throwIfTDZ<T>(value: T, name?: string): Exclude<T, TDZUninitialized> {
  if (value === TDZ_UNINITIALIZED) {
    throw new VMReferenceError(
      `Cannot access '${name || "<binding>"}' before initialization`,
    );
  }
  return value as Exclude<T, TDZUninitialized>;
}

export class RegisterFrame {
  compiledFn: RegisterCompiledFunction;
  pc: number;
  acc: TaggedValue;
  registers: RegisterValue[];
  hasTDZ: boolean;
  thisValue: TaggedValue;
  closureEnv: Environment | null;
  openUpvalues: Map<number, UpvalueCell> | null;
  hasUpvalues: boolean;
  originalArgs: TaggedValue[];
  exceptionHandlers: ExceptionHandlerRecord[] | null;
  locals: RegisterValue[];

  constructor(
    compiledFn: RegisterCompiledFunction,
    args: TaggedValue[],
    thisValue?: TaggedValue | null,
    closureEnv?: Environment | null,
  ) {
    this.compiledFn = compiledFn;
    this.pc = 0;
    this.acc = CODE_UNDEFINED;
    const regCount = compiledFn.registerCount;
    this.registers = new Array<RegisterValue>(regCount).fill(CODE_UNDEFINED);
    this.hasTDZ = compiledFn.uninitializedLocalSlots?.size > 0;
    if (this.hasTDZ) {
      for (const slot of compiledFn.uninitializedLocalSlots) {
        this.registers[slot] = TDZ_UNINITIALIZED;
      }
    }
    this.thisValue = thisValue || CODE_UNDEFINED;
    this.closureEnv = closureEnv || null;
    this.openUpvalues = null;
    this.hasUpvalues = false;
    this.originalArgs = args;
    this.exceptionHandlers = null;
    this.locals = this.registers;

    for (let i = 0; i < args.length && i < compiledFn.paramCount; i++) {
      this.registers[i] = args[i];
    }
  }

  get directRegisters(): RegisterValue[] | null {
    if (!this.hasUpvalues && !this.hasTDZ) return this.registers;
    return null;
  }

  getReg(idx: number): TaggedValue {
    if (this.hasUpvalues && this.openUpvalues?.has(idx)) {
      return throwIfTDZ(
        this.openUpvalues.get(idx)!.get(),
        this.compiledFn.localNames[idx],
      ) as TaggedValue;
    }
    const val = this.registers[idx];
    if (this.hasTDZ && val === TDZ_UNINITIALIZED) {
      throw new VMReferenceError(
        `Cannot access '${this.compiledFn.localNames[idx] || "<binding>"}' before initialization`,
      );
    }
    return (val === undefined ? CODE_UNDEFINED : val) as TaggedValue;
  }

  setReg(idx: number, value: TaggedValue): void {
    if (this.hasUpvalues && this.openUpvalues?.has(idx)) {
      this.openUpvalues.get(idx)!.set(value);
    } else {
      this.registers[idx] = value;
    }
  }

  getOrCreateUpvalueCell(localSlot: number): UpvalueCell {
    if (!this.openUpvalues) {
      this.openUpvalues = new Map();
    }
    this.hasUpvalues = true;
    if (this.openUpvalues.has(localSlot)) {
      return this.openUpvalues.get(localSlot)!;
    }
    const cell = new UpvalueCell(this, localSlot);
    this.openUpvalues.set(localSlot, cell);
    return cell;
  }

  closeUpvalues(): void {
    if (!this.openUpvalues) return;
    for (const cell of this.openUpvalues.values()) {
      cell.close();
    }
  }

  closeUpvaluesFrom(baseSlot: number): void {
    if (!this.openUpvalues) return;
    for (const [slot, cell] of this.openUpvalues) {
      if (slot >= baseSlot) {
        cell.close();
        this.openUpvalues.delete(slot);
      }
    }
    if (this.openUpvalues.size === 0) this.hasUpvalues = false;
  }
}

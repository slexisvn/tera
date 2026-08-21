import {
  type CFGInstruction,
  IR_BRANCH,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_FLOAT64_COMPARE,
  IR_GENERIC_ADD,
  IR_GENERIC_COMPARE,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_INT32_COMPARE,
  IR_INT32_NOT,
  IR_JUMP,
  IR_ARRAY_RESERVE,
  IR_LOAD_ELEMENT,
  IR_LOAD_FIELD,
  IR_LOAD_GLOBAL,
  IR_LOAD_TEXT,
  IR_NEG,
  IR_NEW_OBJECT,
  IR_NOT,
  IR_RETURN,
  IR_RUNTIME_BASE,
  IR_STORE_ELEMENT,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
} from "../ir/index.js";
import type { AotStringBuffer } from "../analyses/aot-legality.js";
import { isPendingThrowReturn } from "../builder/throw-recovery.js";
import {
  builtinIntrinsicByName,
  builtinParameterAt,
} from "../metadata/builtin-methods.js";
import type { MachineTargetModel } from "../target/model.js";
import type { PhysicalRegister } from "../target/registers.js";
import { SCALAR_INT32, SCALAR_STRING, SCALAR_VOID, type AotScalar } from "../types/scalar.js";
import type { FrameLayout, SavedRegister } from "./frame.js";
import {
  def,
  instruction,
  sym,
  use,
  type MachineInstruction,
  type MachineOperand,
  type RegisterOperand,
  type StackSlot,
  type VirtualRegister,
} from "./ir.js";
import type { MachineLowering, SelectionContext, SelectionHandler } from "./lowering.js";
import { nativeArgumentScalar, nativeReturnScalar } from "./signature.js";

export function readOf(register: VirtualRegister): RegisterOperand {
  return use(register, register.width);
}

export function writeOf(register: VirtualRegister): RegisterOperand {
  return def(register, register.width);
}

export abstract class MachineLoweringBase<TTarget extends MachineTargetModel>
  implements MachineLowering
{
  constructor(readonly target: TTarget) {}

  abstract materialize(ctx: SelectionContext, constant: CFGInstruction): VirtualRegister;
  abstract convert(
    ctx: SelectionContext,
    source: VirtualRegister,
    from: AotScalar,
    to: AotScalar,
  ): VirtualRegister;
  abstract copy(destination: RegisterOperand, source: RegisterOperand): MachineInstruction;
  abstract reload(destination: RegisterOperand, slot: StackSlot): MachineInstruction;
  abstract spill(slot: StackSlot, source: RegisterOperand): MachineInstruction;
  abstract storeOutgoing(offset: number, source: RegisterOperand): MachineInstruction;
  abstract jump(target: import("./ir.js").MachineBlock): MachineInstruction;
  abstract storeRoot(
    frame: StackSlot,
    index: number,
    value: RegisterOperand,
    address: VirtualRegister,
  ): readonly MachineInstruction[];

  protected abstract adjustStack(delta: number): MachineInstruction[];
  protected abstract frameSlotAccess(saved: SavedRegister, store: boolean): MachineInstruction;
  protected abstract enterRoots(frame: FrameLayout): readonly MachineInstruction[];
  protected abstract leaveRoots(frame: FrameLayout): readonly MachineInstruction[];
  protected abstract textAddress(
    ctx: SelectionContext,
    destination: VirtualRegister,
  ): VirtualRegister;
  protected abstract bufferAddress(
    ctx: SelectionContext,
    buffer: AotStringBuffer,
  ): VirtualRegister;
  protected abstract emitBufferCall(
    ctx: SelectionContext,
    symbol: string,
    buffer: AotStringBuffer,
    address: VirtualRegister,
    operands: readonly VirtualRegister[],
  ): VirtualRegister;

  protected abstract floatBinaryRules(): ReadonlyMap<string, string>;
  protected abstract intBinaryRules(): ReadonlyMap<string, string>;
  protected abstract intShiftRules(): ReadonlyMap<string, string>;
  protected abstract intHelperRules(): ReadonlyMap<string, string>;

  protected abstract selectBranch(ctx: SelectionContext): void;
  protected abstract selectIntNot(ctx: SelectionContext): void;
  protected abstract selectIntCompare(ctx: SelectionContext): void;
  protected abstract selectFloatCompare(ctx: SelectionContext): void;
  protected abstract selectNegate(ctx: SelectionContext): void;
  protected abstract selectLogicalNot(ctx: SelectionContext): void;
  protected abstract selectNewObject(ctx: SelectionContext): void;
  protected abstract selectArrayReserve(ctx: SelectionContext): void;
  protected abstract selectRuntimeBase(ctx: SelectionContext): void;
  protected abstract selectLoadField(ctx: SelectionContext): void;
  protected abstract selectStoreField(ctx: SelectionContext): void;
  protected abstract selectStoreText(ctx: SelectionContext): void;
  protected abstract selectLoadElement(ctx: SelectionContext): void;
  protected abstract selectStoreElement(ctx: SelectionContext): void;
  protected abstract selectKnownCall(ctx: SelectionContext): void;
  protected abstract selectBuiltin(ctx: SelectionContext): void;
  protected abstract selectStringConcat(ctx: SelectionContext): void;
  protected abstract selectStringCompare(ctx: SelectionContext): void;
  protected abstract selectFloatBinary(ctx: SelectionContext, mnemonic: string): void;
  protected abstract selectIntBinary(ctx: SelectionContext, mnemonic: string): void;
  protected abstract selectShift(ctx: SelectionContext, mnemonic: string): void;

  rules(): Iterable<readonly [string, SelectionHandler]> {
    const entries: Array<readonly [string, SelectionHandler]> = [
      [IR_LOAD_GLOBAL, () => undefined],
      [IR_RETURN, (ctx) => this.selectReturn(ctx)],
      [IR_JUMP, (ctx) => void ctx.emit(this.jump(ctx.successorFor("targetBlock")))],
      [IR_BRANCH, (ctx) => this.selectBranch(ctx)],
      [IR_INT32_NOT, (ctx) => this.selectIntNot(ctx)],
      [IR_INT32_COMPARE, (ctx) => this.selectIntCompare(ctx)],
      [IR_FLOAT64_COMPARE, (ctx) => this.selectFloatCompare(ctx)],
      [IR_NEG, (ctx) => this.selectNegate(ctx)],
      [IR_NOT, (ctx) => this.selectLogicalNot(ctx)],
      [IR_NEW_OBJECT, (ctx) => this.selectNewObject(ctx)],
      [IR_ARRAY_RESERVE, (ctx) => this.selectArrayReserve(ctx)],
      [IR_RUNTIME_BASE, (ctx) => this.selectRuntimeBase(ctx)],
      [IR_LOAD_FIELD, (ctx) => this.selectLoadField(ctx)],
      [IR_STORE_FIELD, (ctx) => this.selectStoreField(ctx)],
      [IR_LOAD_TEXT, (ctx) => this.selectLoadText(ctx)],
      [IR_STORE_TEXT, (ctx) => this.selectStoreText(ctx)],
      [IR_LOAD_ELEMENT, (ctx) => this.selectLoadElement(ctx)],
      [IR_GENERIC_GET_INDEX, (ctx) => this.selectLoadElement(ctx)],
      [IR_STORE_ELEMENT, (ctx) => this.selectStoreElement(ctx)],
      [IR_GENERIC_SET_INDEX, (ctx) => this.selectStoreElement(ctx)],
      [IR_CALL_KNOWN_FUNCTION, (ctx) => this.selectKnownCall(ctx)],
      [IR_CALL_BUILTIN, (ctx) => this.selectBuiltin(ctx)],
      [IR_GENERIC_ADD, (ctx) => this.selectStringConcat(ctx)],
      [IR_GENERIC_COMPARE, (ctx) => this.selectStringCompare(ctx)],
    ];
    for (const [opcode, mnemonic] of this.floatBinaryRules()) {
      entries.push([opcode, (ctx) => this.selectFloatBinary(ctx, mnemonic)]);
    }
    for (const [opcode, mnemonic] of this.intBinaryRules()) {
      entries.push([opcode, (ctx) => this.selectIntBinary(ctx, mnemonic)]);
    }
    for (const [opcode, mnemonic] of this.intShiftRules()) {
      entries.push([opcode, (ctx) => this.selectShift(ctx, mnemonic)]);
    }
    for (const [opcode, symbol] of this.intHelperRules()) {
      entries.push([opcode, (ctx) => this.selectIntHelper(ctx, symbol)]);
    }
    return entries;
  }

  loadIncoming(destination: RegisterOperand, slot: StackSlot): MachineInstruction {
    return this.reload(destination, slot);
  }

  call(symbol: string, operands: MachineOperand[]): MachineInstruction {
    return instruction("call", [sym(symbol), ...operands], {
      call: true,
      implicitFrom: 1,
    });
  }

  prologue(frame: FrameLayout): readonly MachineInstruction[] {
    return [
      ...this.adjustStack(-frame.frameSize),
      ...frame.saved.map((saved) => this.frameSlotAccess(saved, true)),
      ...this.enterRoots(frame),
    ];
  }

  epilogue(frame: FrameLayout): readonly MachineInstruction[] {
    return [
      ...this.leaveRoots(frame),
      ...frame.saved.map((saved) => this.frameSlotAccess(saved, false)),
      ...this.adjustStack(frame.frameSize),
    ];
  }

  protected physical(name: string): PhysicalRegister {
    return this.target.registers.register(name);
  }

  protected stackPointer(): RegisterOperand {
    return use(this.target.abi.stackPointer, 8);
  }

  protected coerce(
    ctx: SelectionContext,
    value: CFGInstruction,
    scalar: AotScalar,
  ): VirtualRegister {
    return this.convert(ctx, ctx.registerOf(value), ctx.scalarOf(value), scalar);
  }

  protected destination(ctx: SelectionContext, scalar: AotScalar): VirtualRegister {
    return ctx.scalarOf(ctx.node) === scalar ? ctx.resultRegister() : ctx.temp(scalar);
  }

  protected produce(ctx: SelectionContext, value: VirtualRegister, scalar: AotScalar): void {
    const wanted = ctx.scalarOf(ctx.node);
    if (scalar === wanted && value === ctx.resultRegister()) return;
    const converted = this.convert(ctx, value, scalar, wanted);
    ctx.emit(this.copy(ctx.resultOf(), readOf(converted)));
  }

  protected selectReturn(ctx: SelectionContext): void {
    const scalar = nativeReturnScalar(ctx.legality);
    if (scalar === SCALAR_VOID || isPendingThrowReturn(ctx.node)) {
      ctx.emit(instruction("ret", [], { terminator: true, returns: true }));
      return;
    }
    const value = this.coerce(ctx, ctx.node.inputs[0]!, scalar);
    const width = ctx.widthOf(scalar);
    const returned = this.target.abi.callingConvention.returnRegisters.get(
      ctx.classOf(scalar),
    )!;
    ctx.emit(this.copy(def(returned, width), use(value, width)));
    ctx.emit(
      instruction("ret", [use(returned, width)], {
        terminator: true,
        returns: true,
        implicitFrom: 0,
      }),
    );
  }

  protected selectIntHelper(ctx: SelectionContext, symbol: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.external(symbol);
    ctx.emitCall(symbol, [left, right], result);
    this.produce(ctx, result, SCALAR_INT32);
  }

  protected selectLoadText(ctx: SelectionContext): void {
    const address = this.textAddress(ctx, this.destination(ctx, SCALAR_STRING));
    this.produce(ctx, address, SCALAR_STRING);
  }

  protected selectStringBuffered(ctx: SelectionContext, symbol: string): void {
    const buffer = ctx.legality.stringBufferOf(ctx.node)!;
    const intrinsic = builtinIntrinsicByName(String(ctx.node.props.name))!;
    const operands = ctx.node.inputs.map((input, index) =>
      this.coerce(
        ctx,
        input,
        nativeArgumentScalar(builtinParameterAt(intrinsic, index), ctx.classes),
      ),
    );
    const result = this.emitBufferCall(
      ctx,
      symbol,
      buffer,
      this.bufferAddress(ctx, buffer),
      operands,
    );
    this.produce(ctx, result, SCALAR_STRING);
  }

  protected emitLibraryCall(
    ctx: SelectionContext,
    symbol: string,
    args: readonly VirtualRegister[],
    scalar: AotScalar,
  ): void {
    ctx.external(symbol);
    const result = this.destination(ctx, scalar);
    ctx.emitCall(symbol, args, result);
    this.produce(ctx, result, scalar);
  }
}

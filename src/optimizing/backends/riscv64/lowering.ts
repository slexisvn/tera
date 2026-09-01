import {
  type CFGInstruction,
  IR_BRANCH,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_FLOAT64_ADD,
  IR_FLOAT64_COMPARE,
  IR_FLOAT64_DIV,
  IR_FLOAT64_MUL,
  IR_FLOAT64_SUB,
  IR_GENERIC_ADD,
  IR_GENERIC_COMPARE,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_INT32_ADD,
  IR_INT32_AND,
  IR_INT32_COMPARE,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_INT32_MUL,
  IR_INT32_NOT,
  IR_INT32_OR,
  IR_INT32_SHL,
  IR_INT32_SHR,
  IR_INT32_SUB,
  IR_INT32_USHR,
  IR_INT32_XOR,
  IR_JUMP,
  arrayReserveOf,
  heapElementScalarOf,
  IR_ARRAY_RESERVE,
  IR_LOAD_ELEMENT,
  IR_LOAD_GLOBAL,
  IR_NEG,
  IR_LOAD_FIELD,
  IR_NEW_OBJECT,
  IR_RUNTIME_BASE,
  IR_STORE_FIELD,
  allocationShapeOf,
  fieldOffsetOf,
  fieldScalarOf,
  textCapacityOf,
  IR_LOAD_TEXT,
  IR_NOT,
  IR_RETURN,
  IR_STORE_ELEMENT,
  IR_STORE_TEXT,
} from "../../ir/index.js";
import {
  AOT_CHAR_AT,
  AOT_FLOAT_TO_STRING,
  AOT_INT_TO_STRING,
  type AotStringBuffer,
} from "../../analyses/aot-legality.js";
import { calleeSymbolName } from "../../metadata/call-signatures.js";
import { callThroughArguments, codeSymbolOf } from "../../analyses/aot-legality.js";
import { isPendingThrowReturn } from "../../builder/throw-recovery.js";
import { doubleBits } from "../../target/float64.js";
import { asciiData, integerData, zeroFilledBuffer } from "../../machine/data.js";
import type { FrameLayout, SavedRegister } from "../../machine/frame.js";
import { fitsImmediate } from "./immediates.js";
import type { DeclaredSignature } from "../../types/signature.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_CODE,
  SCALAR_STRING,
  SCALAR_TEXT,
  scalarWidth,
  SCALAR_VOID,
  type AotScalar,
} from "../../types/scalar.js";
import {
  builtinIntrinsicByName,
  builtinParameterAt,
  INPUT_BUILTIN,
  PRINT_BUILTIN,
  printTerminatorAt,
  qualifiedMethodName,
  THROW_BUILTIN,
} from "../../metadata/builtin-methods.js";
import { BackendLoweringError } from "../../target/errors.js";
import {
  def,
  imm,
  instruction,
  label,
  mem,
  sym,
  use,
  type MachineAddress,
  type MachineBlock,
  type MachineInstruction,
  type MachineOperand,
  type RegisterOperand,
  type StackSlot,
  type VirtualRegister,
} from "../../machine/ir.js";
import type { SelectionContext, SelectionHandler } from "../../machine/lowering.js";
import { MachineLoweringBase, readOf, writeOf } from "../../machine/lowering-base.js";
import type { InstructionEffect } from "../../machine/schedule.js";
import { fusedConditionOf } from "../../machine/select.js";
import { nativeArgumentScalar, nativeReturnScalar } from "../../machine/signature.js";
import { RISCV_FPR, RISCV_GPR, RISCV_STACK_SCRATCH } from "./registers.js";
import { RISCV_RUNTIME_SYMBOLS } from "./runtime-symbols.js";
import {
  ROOT_COUNT_REGISTER,
  ROOT_ENTRY_BYTES,
  ROOT_FRAME_REGISTER,
  ROOT_SLOT_SHIFT,
} from "./heap.js";
import { TERA_POINTER_BYTES } from "../../target/runtime-layout.js";
import { contextAddress, contextField } from "./context.js";
import type { PhysicalRegister } from "../../target/registers.js";
import type { RiscvTargetModel } from "./target.js";

interface IntCondition {
  readonly branch: string;
  readonly swap: boolean;
  readonly negate: boolean;
  readonly equality: boolean;
}

const OPPOSITE_BRANCHES = new Map<string, string>(
  [
    ["beq", "bne"],
    ["blt", "bge"],
    ["bltu", "bgeu"],
  ].flatMap(([branch, opposite]) => [
    [branch, opposite] as [string, string],
    [opposite, branch] as [string, string],
  ]),
);

const INT_CONDITIONS = new Map<string, IntCondition>([
  ["<", { branch: "blt", swap: false, negate: false, equality: false }],
  ["<=", { branch: "bge", swap: true, negate: true, equality: false }],
  [">", { branch: "blt", swap: true, negate: false, equality: false }],
  [">=", { branch: "bge", swap: false, negate: true, equality: false }],
  ["==", { branch: "beq", swap: false, negate: false, equality: true }],
  ["loose==", { branch: "beq", swap: false, negate: false, equality: true }],
  ["!=", { branch: "bne", swap: false, negate: true, equality: true }],
  ["loose!=", { branch: "bne", swap: false, negate: true, equality: true }],
]);

interface FloatCondition {
  readonly compare: string;
  readonly swap: boolean;
  readonly negate: boolean;
}

const FLOAT_CONDITIONS = new Map<string, FloatCondition>([
  ["<", { compare: "flt.d", swap: false, negate: false }],
  ["<=", { compare: "fle.d", swap: false, negate: false }],
  [">", { compare: "flt.d", swap: true, negate: false }],
  [">=", { compare: "fle.d", swap: true, negate: false }],
  ["==", { compare: "feq.d", swap: false, negate: false }],
  ["loose==", { compare: "feq.d", swap: false, negate: false }],
  ["!=", { compare: "feq.d", swap: false, negate: true }],
  ["loose!=", { compare: "feq.d", swap: false, negate: true }],
]);

const FLOAT_BINARY = new Map<string, string>([
  [IR_FLOAT64_ADD, "fadd.d"],
  [IR_FLOAT64_SUB, "fsub.d"],
  [IR_FLOAT64_MUL, "fmul.d"],
  [IR_FLOAT64_DIV, "fdiv.d"],
]);

const INT_BINARY = new Map<string, string>([
  [IR_INT32_ADD, "addw"],
  [IR_INT32_SUB, "subw"],
  [IR_INT32_MUL, "mulw"],
  [IR_INT32_AND, "and"],
  [IR_INT32_OR, "or"],
  [IR_INT32_XOR, "xor"],
]);

const INT_SHIFT = new Map<string, string>([
  [IR_INT32_SHL, "sllw"],
  [IR_INT32_SHR, "sraw"],
  [IR_INT32_USHR, "srlw"],
]);

const MULTIPLY_LATENCY = 3;
const LOAD_LATENCY = 3;
const FLOAT_LATENCY = 4;
const FLOAT_DIVIDE_LATENCY = 14;

const LATENCIES: ReadonlyMap<string, number> = new Map<string, number>([
  ["mulw", MULTIPLY_LATENCY],
  ["mul", MULTIPLY_LATENCY],
  ["ld", LOAD_LATENCY],
  ["lw", LOAD_LATENCY],
  ["lbu", LOAD_LATENCY],
  ["fld", LOAD_LATENCY],
  ["fadd.d", FLOAT_LATENCY],
  ["fsub.d", FLOAT_LATENCY],
  ["fmul.d", FLOAT_LATENCY],
  ["feq.d", FLOAT_LATENCY],
  ["flt.d", FLOAT_LATENCY],
  ["fle.d", FLOAT_LATENCY],
  ["fcvt.d.w", FLOAT_LATENCY],
  ["fcvt.d.l", FLOAT_LATENCY],
  ["fcvt.w.d", FLOAT_LATENCY],
  ["fcvt.l.d", FLOAT_LATENCY],
  ["fdiv.d", FLOAT_DIVIDE_LATENCY],
  ["fsqrt.d", FLOAT_DIVIDE_LATENCY],
]);

const INT_HELPERS = new Map<string, string>([
  [IR_INT32_DIV, RISCV_RUNTIME_SYMBOLS.divide],
  [IR_INT32_MOD, RISCV_RUNTIME_SYMBOLS.modulo],
]);

const LIBM_CALLS = new Map<string, string>([
  [qualifiedMethodName("Math", "floor"), RISCV_RUNTIME_SYMBOLS.floor],
  [qualifiedMethodName("Math", "ceil"), RISCV_RUNTIME_SYMBOLS.ceil],
  [qualifiedMethodName("Math", "trunc"), RISCV_RUNTIME_SYMBOLS.trunc],
]);

const RUNTIME_BUILTINS = new Map<string, string>([
  [qualifiedMethodName("Math", "min"), RISCV_RUNTIME_SYMBOLS.minimum],
  [qualifiedMethodName("Math", "max"), RISCV_RUNTIME_SYMBOLS.maximum],
  [qualifiedMethodName("string", "char_code_at"), RISCV_RUNTIME_SYMBOLS.charCodeAt],
]);

const STRING_BUFFER_BUILTINS = new Map<string, string>([
  [AOT_CHAR_AT, RISCV_RUNTIME_SYMBOLS.charAt],
  [AOT_INT_TO_STRING, RISCV_RUNTIME_SYMBOLS.int32ToString],
  [AOT_FLOAT_TO_STRING, RISCV_RUNTIME_SYMBOLS.floatToString],
  [INPUT_BUILTIN, RISCV_RUNTIME_SYMBOLS.input],
]);

const PRINT_ROUTINES = new Map<AotScalar, string>([
  [SCALAR_STRING, RISCV_RUNTIME_SYMBOLS.printString],
  [SCALAR_INT32, RISCV_RUNTIME_SYMBOLS.printInt],
  [SCALAR_FLOAT64, RISCV_RUNTIME_SYMBOLS.printFloat],
]);

const SHIFT_MASK = 31;

function calleeSignature(node: CFGInstruction): DeclaredSignature | null {
  const target = node.props.target as { declaredSignature?: DeclaredSignature } | undefined;
  return target?.declaredSignature ?? null;
}

function log2(value: number): number {
  return Math.round(Math.log2(value));
}

export class RiscvLowering extends MachineLoweringBase<RiscvTargetModel> {

  effectOf(node: MachineInstruction): InstructionEffect {
    const latency = LATENCIES.get(node.opcode);
    return latency === undefined ? {} : { latency };
  }

  protected floatBinaryRules(): ReadonlyMap<string, string> {
    return FLOAT_BINARY;
  }

  protected intBinaryRules(): ReadonlyMap<string, string> {
    return INT_BINARY;
  }

  protected intShiftRules(): ReadonlyMap<string, string> {
    return INT_SHIFT;
  }

  protected intHelperRules(): ReadonlyMap<string, string> {
    return INT_HELPERS;
  }

  materialize(ctx: SelectionContext, constant: CFGInstruction): VirtualRegister {
    const scalar = ctx.scalarOf(constant);
    const value = constant.props.value;
    if (scalar === SCALAR_STRING) {
      const text = String(value);
      const datum = ctx.data.intern(
        `string:${text}`,
        1,
        [asciiData(text)],
        ".LS",
      );
      const destination = ctx.temp(scalar);
      ctx.emit(instruction("lla", [writeOf(destination), sym(datum.label)]));
      return destination;
    }
    if (scalar === SCALAR_CODE) {
      const symbol = this.target.symbolOf(codeSymbolOf(constant)!);
      const destination = ctx.temp(scalar);
      ctx.reference(symbol);
      ctx.emit(instruction("lla", [writeOf(destination), sym(symbol)]));
      return destination;
    }
    return this.loadNumber(ctx, Number(value), scalar);
  }

  convert(
    ctx: SelectionContext,
    source: VirtualRegister,
    from: AotScalar,
    to: AotScalar,
  ): VirtualRegister {
    if (from === to) return source;
    if (from === SCALAR_STRING || to === SCALAR_STRING) {
      throw new BackendLoweringError(`cannot convert ${from} to ${to}`);
    }
    const destination = ctx.temp(to);
    if (to === SCALAR_FLOAT64) {
      ctx.emit(instruction("fcvt.d.w", [writeOf(destination), readOf(source)]));
      return destination;
    }
    ctx.external(RISCV_RUNTIME_SYMBOLS.toInt32);
    ctx.emitCall(RISCV_RUNTIME_SYMBOLS.toInt32, [source], destination);
    return destination;
  }

  copy(destination: RegisterOperand, source: RegisterOperand): MachineInstruction {
    const mnemonic = destination.register.classId === RISCV_FPR ? "fmv.d" : "mv";
    return instruction(mnemonic, [destination, source], { copy: true });
  }

  reload(destination: RegisterOperand, slot: StackSlot): MachineInstruction {
    return instruction(this.loadFor(destination), [
      destination,
      mem(destination.width, { base: this.stackPointer(), slot }),
    ]);
  }

  spill(slot: StackSlot, source: RegisterOperand): MachineInstruction {
    return instruction(this.storeFor(source), [
      source,
      mem(source.width, { base: this.stackPointer(), slot }),
    ]);
  }

  storeOutgoing(offset: number, source: RegisterOperand): MachineInstruction {
    return instruction(this.storeFor(source), [
      source,
      mem(source.width, { base: this.stackPointer(), displacement: offset }),
    ]);
  }

  invertBranch(node: MachineInstruction, target: MachineBlock): MachineInstruction | null {
    const opposite = OPPOSITE_BRANCHES.get(node.opcode);
    if (opposite === undefined) return null;
    const carried = node.operands.slice(0, -1);
    if (node.operands[node.operands.length - 1]?.kind !== "label") return null;
    return instruction(opposite, [...carried, label(target)], { terminator: true });
  }

  fusedInputOf(): CFGInstruction | null {
    return null;
  }

  jump(target: MachineBlock): MachineInstruction {
    return instruction("j", [label(target)], { terminator: true });
  }

  storeRoot(
    frame: StackSlot,
    index: number,
    value: RegisterOperand,
    address: VirtualRegister,
  ): readonly MachineInstruction[] {
    return [
      instruction("ld", [
        writeOf(address),
        mem(8, { base: this.stackPointer(), slot: frame }),
      ]),
      instruction("sd", [
        value,
        mem(8, { base: readOf(address), displacement: index * ROOT_ENTRY_BYTES }),
      ]),
    ];
  }

  protected enterRoots(frame: FrameLayout): readonly MachineInstruction[] {
    if (frame.rootFrame === null) return [];
    return [
      instruction("li", [def(this.physical(ROOT_COUNT_REGISTER), 8), imm(frame.roots)]),
      instruction("call", [sym(RISCV_RUNTIME_SYMBOLS.enterRoots)], {
        call: true,
        implicitFrom: 1,
      }),
      instruction("sd", [
        use(this.physical(ROOT_FRAME_REGISTER), 8),
        mem(8, { base: this.stackPointer(), slot: frame.rootFrame }),
      ]),
    ];
  }

  protected leaveRoots(frame: FrameLayout): readonly MachineInstruction[] {
    if (frame.rootFrame === null) return [];
    const cursor = this.physical(ROOT_FRAME_REGISTER);
    const table = this.physical(ROOT_COUNT_REGISTER);
    return [
      instruction("ld", [
        def(cursor, 8),
        mem(8, { base: this.stackPointer(), slot: frame.rootFrame }),
      ]),
      instruction("lla", [def(table, 8), contextAddress()]),
      instruction("ld", [def(table, 8), contextField(use(table, 8), "rootsBase")]),
      instruction("sub", [def(cursor, 8), use(cursor, 8), use(table, 8)]),
      instruction("srli", [def(cursor, 8), use(cursor, 8), imm(ROOT_SLOT_SHIFT)]),
      instruction("lla", [def(table, 8), contextAddress()]),
      instruction("sd", [use(cursor, 8), contextField(use(table, 8), "rootCount")]),
    ];
  }

  protected adjustStack(delta: number): MachineInstruction[] {
    if (delta === 0) return [];
    const pointer = this.target.abi.stackPointer;
    if (fitsImmediate(delta)) {
      return [
        instruction("addi", [def(pointer, 8), use(pointer, 8), imm(delta)]),
      ];
    }
    const scratch = this.target.registers.register(RISCV_STACK_SCRATCH);
    return [
      instruction("li", [def(scratch, 8), imm(delta)]),
      instruction("add", [def(pointer, 8), use(pointer, 8), use(scratch, 8)]),
    ];
  }

  protected frameSlotAccess(saved: SavedRegister, store: boolean): MachineInstruction {
    const width = this.target.registers.classOf(saved.register.classId).saveBytes;
    const operand = store ? use(saved.register, width) : def(saved.register, width);
    const location = mem(width, {
      base: this.stackPointer(),
      displacement: saved.offset,
    });
    const mnemonic = store ? this.storeFor(operand) : this.loadFor(operand);
    return instruction(mnemonic, [operand, location]);
  }

  loadFor(operand: RegisterOperand): string {
    if (operand.register.classId === RISCV_FPR) return "fld";
    return operand.width === 8 ? "ld" : "lw";
  }

  storeFor(operand: RegisterOperand): string {
    if (operand.register.classId === RISCV_FPR) return "fsd";
    return operand.width === 8 ? "sd" : "sw";
  }

  private zero(): RegisterOperand {
    return use(this.target.registers.register("zero"), 8);
  }

  private loadNumber(
    ctx: SelectionContext,
    value: number,
    scalar: AotScalar,
    into: VirtualRegister = ctx.temp(scalar),
  ): VirtualRegister {
    if (scalar === SCALAR_INT32) {
      ctx.emit(instruction("li", [writeOf(into), imm(value | 0)]));
      return into;
    }
    if (scalar === SCALAR_POINTER) {
      ctx.emit(instruction("li", [writeOf(into), imm(value)]));
      return into;
    }
    const bits = doubleBits(value);
    const datum = ctx.data.intern(`double:${bits}`, 8, [integerData(bits, 8)]);
    const address = ctx.tempIn(RISCV_GPR, 8);
    ctx.emit(instruction("lla", [writeOf(address), sym(datum.label)]));
    ctx.emit(
      instruction("fld", [writeOf(into), mem(8, { base: readOf(address) })]),
    );
    return into;
  }

  protected selectFloatBinary(ctx: SelectionContext, mnemonic: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_FLOAT64);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_FLOAT64);
    const result = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(instruction(mnemonic, [writeOf(result), readOf(left), readOf(right)]));
    this.produce(ctx, result, SCALAR_FLOAT64);
  }

  protected selectIntBinary(ctx: SelectionContext, mnemonic: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.emit(
      instruction(mnemonic, [writeOf(result), readOf(left), readOf(right)]),
    );
    this.produce(ctx, result, SCALAR_INT32);
  }

  protected selectIntNot(ctx: SelectionContext): void {
    const operand = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.emit(instruction("xori", [writeOf(result), readOf(operand), imm(-1)]));
    this.produce(ctx, result, SCALAR_INT32);
  }

  protected selectShift(ctx: SelectionContext, mnemonic: string): void {
    const value = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const amount = ctx.node.inputs[1]!;
    const wide = mnemonic === "srlw" && ctx.scalarOf(ctx.node) === SCALAR_FLOAT64;
    const shifted = wide ? ctx.tempIn(RISCV_GPR, 8) : this.destination(ctx, SCALAR_INT32);
    const count = this.coerce(ctx, amount, SCALAR_INT32);
    const masked = ctx.temp(SCALAR_INT32);
    ctx.emit(instruction("andi", [writeOf(masked), readOf(count), imm(SHIFT_MASK)]));
    ctx.emit(
      instruction(mnemonic, [def(shifted, 4), readOf(value), readOf(masked)]),
    );
    if (!wide) {
      this.produce(ctx, shifted, SCALAR_INT32);
      return;
    }
    const widened = ctx.tempIn(RISCV_GPR, 8);
    ctx.emit(instruction("slli", [writeOf(widened), use(shifted, 8), imm(32)]));
    ctx.emit(instruction("srli", [writeOf(widened), readOf(widened), imm(32)]));
    const converted = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(instruction("fcvt.d.l", [writeOf(converted), readOf(widened)]));
    this.produce(ctx, converted, SCALAR_FLOAT64);
  }

  protected selectNegate(ctx: SelectionContext): void {
    if (ctx.scalarOf(ctx.node) === SCALAR_INT32) {
      const operand = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
      const result = this.destination(ctx, SCALAR_INT32);
      ctx.emit(instruction("subw", [writeOf(result), this.zero(), readOf(operand)]));
      this.produce(ctx, result, SCALAR_INT32);
      return;
    }
    const operand = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_FLOAT64);
    const result = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(instruction("fneg.d", [writeOf(result), readOf(operand)]));
    this.produce(ctx, result, SCALAR_FLOAT64);
  }

  protected selectLogicalNot(ctx: SelectionContext): void {
    const operand = ctx.node.inputs[0]!;
    const result = this.destination(ctx, SCALAR_INT32);
    if (ctx.scalarOf(operand) === SCALAR_FLOAT64) {
      const zero = this.loadNumber(ctx, 0, SCALAR_FLOAT64);
      ctx.emit(
        instruction("feq.d", [
          writeOf(result),
          readOf(ctx.registerOf(operand)),
          readOf(zero),
        ]),
      );
    } else {
      const value = ctx.registerOf(operand);
      ctx.emit(instruction("seqz", [writeOf(result), readOf(value)]));
    }
    this.produce(ctx, result, SCALAR_INT32);
  }

  private intCondition(operation: string): IntCondition {
    const condition = INT_CONDITIONS.get(operation);
    if (condition === undefined) {
      throw new BackendLoweringError(`unsupported comparison ${operation}`);
    }
    return condition;
  }

  private floatCondition(operation: string): FloatCondition {
    const condition = FLOAT_CONDITIONS.get(operation);
    if (condition === undefined) {
      throw new BackendLoweringError(`unsupported comparison ${operation}`);
    }
    return condition;
  }

  protected selectIntCompare(ctx: SelectionContext): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
    this.emitIntCondition(ctx, String(ctx.node.props.op), left, right);
  }

  protected selectStringCompare(ctx: SelectionContext): void {
    if (ctx.node.inputs.every((input) => ctx.scalarOf(input) === SCALAR_POINTER)) {
      this.emitIntCondition(
        ctx,
        String(ctx.node.props.op),
        ctx.registerOf(ctx.node.inputs[0]!),
        ctx.registerOf(ctx.node.inputs[1]!),
      );
      return;
    }
    const left = ctx.registerOf(ctx.node.inputs[0]!);
    const right = ctx.registerOf(ctx.node.inputs[1]!);
    const ordering = ctx.temp(SCALAR_INT32);
    ctx.external(RISCV_RUNTIME_SYMBOLS.stringCompare);
    ctx.emitCall(RISCV_RUNTIME_SYMBOLS.stringCompare, [left, right], ordering);
    const zero = this.loadNumber(ctx, 0, SCALAR_INT32);
    this.emitIntCondition(ctx, String(ctx.node.props.op), ordering, zero);
  }

  private emitIntCondition(
    ctx: SelectionContext,
    operation: string,
    left: VirtualRegister,
    right: VirtualRegister,
  ): void {
    const condition = this.intCondition(operation);
    const result = this.destination(ctx, SCALAR_INT32);
    if (condition.equality) {
      ctx.emit(instruction("xor", [writeOf(result), readOf(left), readOf(right)]));
      ctx.emit(
        instruction(condition.negate ? "snez" : "seqz", [
          writeOf(result),
          readOf(result),
        ]),
      );
    } else {
      const ordered = condition.swap ? [right, left] : [left, right];
      ctx.emit(
        instruction("slt", [writeOf(result), readOf(ordered[0]!), readOf(ordered[1]!)]),
      );
      if (condition.negate) {
        ctx.emit(instruction("xori", [writeOf(result), readOf(result), imm(1)]));
      }
    }
    this.produce(ctx, result, SCALAR_INT32);
  }

  private emitFloatCondition(
    ctx: SelectionContext,
    operation: string,
    left: VirtualRegister,
    right: VirtualRegister,
    result: VirtualRegister,
  ): void {
    const condition = this.floatCondition(operation);
    const ordered = condition.swap ? [right, left] : [left, right];
    ctx.emit(
      instruction(condition.compare, [
        writeOf(result),
        readOf(ordered[0]!),
        readOf(ordered[1]!),
      ]),
    );
    if (condition.negate) {
      ctx.emit(instruction("xori", [writeOf(result), readOf(result), imm(1)]));
    }
  }

  protected selectFloatCompare(ctx: SelectionContext): void {
    if (ctx.node.inputs.every((input) => ctx.scalarOf(input) === SCALAR_POINTER)) {
      this.emitIntCondition(
        ctx,
        String(ctx.node.props.op),
        ctx.registerOf(ctx.node.inputs[0]!),
        ctx.registerOf(ctx.node.inputs[1]!),
      );
      return;
    }
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_FLOAT64);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_FLOAT64);
    const result = this.destination(ctx, SCALAR_INT32);
    this.emitFloatCondition(ctx, String(ctx.node.props.op), left, right, result);
    this.produce(ctx, result, SCALAR_INT32);
  }

  protected selectBranch(ctx: SelectionContext): void {
    const onTrue = ctx.successorFor("trueBlock");
    const onFalse = ctx.successorFor("falseBlock");
    const fused = fusedConditionOf(ctx);

    if (fused !== null && fused.type === IR_INT32_COMPARE) {
      const condition = this.intCondition(String(fused.props.op));
      const left = this.coerce(ctx, fused.inputs[0]!, SCALAR_INT32);
      const right = this.coerce(ctx, fused.inputs[1]!, SCALAR_INT32);
      const ordered = condition.swap ? [right, left] : [left, right];
      ctx.emit(
        instruction(condition.branch, [
          readOf(ordered[0]!),
          readOf(ordered[1]!),
          label(onTrue),
        ]),
      );
    } else if (fused !== null) {
      const left = this.coerce(ctx, fused.inputs[0]!, SCALAR_FLOAT64);
      const right = this.coerce(ctx, fused.inputs[1]!, SCALAR_FLOAT64);
      const flag = ctx.temp(SCALAR_INT32);
      this.emitFloatCondition(ctx, String(fused.props.op), left, right, flag);
      ctx.emit(instruction("bnez", [readOf(flag), label(onTrue)]));
    } else {
      const condition = ctx.node.inputs[0]!;
      if (ctx.scalarOf(condition) === SCALAR_FLOAT64) {
        const zero = this.loadNumber(ctx, 0, SCALAR_FLOAT64);
        const flag = ctx.temp(SCALAR_INT32);
        this.emitFloatCondition(ctx, "!=", ctx.registerOf(condition), zero, flag);
        ctx.emit(instruction("bnez", [readOf(flag), label(onTrue)]));
      } else {
        const value = ctx.registerOf(condition);
        ctx.emit(instruction("bnez", [readOf(value), label(onTrue)]));
      }
    }
    ctx.emit(this.jump(onFalse));
  }

  private elementAddress(
    ctx: SelectionContext,
    width: number,
    index: CFGInstruction | null,
  ): VirtualRegister {
    const address = ctx.tempIn(RISCV_GPR, 8);
    if (index === null) {
      ctx.emit(instruction("mv", [writeOf(address), this.stackPointer()]));
      return address;
    }
    const scaled = this.coerce(ctx, index, SCALAR_INT32);
    ctx.emit(instruction("slli", [writeOf(address), readOf(scaled), imm(log2(width))]));
    ctx.emit(
      instruction("add", [writeOf(address), readOf(address), this.stackPointer()]),
    );
    return address;
  }

  protected selectNewObject(ctx: SelectionContext): void {
    const shape = allocationShapeOf(ctx.node);
    const size = this.loadNumber(ctx, shape.size, SCALAR_INT32);
    const identity = this.loadNumber(ctx, shape.id, SCALAR_INT32);
    ctx.external(RISCV_RUNTIME_SYMBOLS.allocate);
    ctx.emitCall(RISCV_RUNTIME_SYMBOLS.allocate, [size, identity], ctx.resultRegister());
  }

  protected selectArrayReserve(ctx: SelectionContext): void {
    const growth = arrayReserveOf(ctx.node);
    const array = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_POINTER);
    const buffer = this.loadNumber(ctx, growth.buffer, SCALAR_INT32);
    const stride = this.loadNumber(ctx, growth.elementBytes, SCALAR_INT32);
    ctx.external(RISCV_RUNTIME_SYMBOLS.arrayReserve);
    ctx.emitCall(
      RISCV_RUNTIME_SYMBOLS.arrayReserve,
      [array, buffer, stride],
      ctx.resultRegister(),
    );
  }

  protected selectRuntimeBase(ctx: SelectionContext): void {
    const base = ctx.resultRegister();
    ctx.emit(instruction("lla", [writeOf(base), sym(String(ctx.node.props.symbol))]));
  }

  protected selectLoadField(ctx: SelectionContext): void {
    const scalar = fieldScalarOf(ctx.node);
    const width = ctx.widthOf(scalar);
    const receiver = ctx.registerOf(ctx.node.inputs[0]!);
    const loaded = this.destination(ctx, scalar);
    ctx.emit(
      instruction(this.loadFor(writeOf(loaded)), [
        writeOf(loaded),
        mem(width, { base: readOf(receiver), displacement: fieldOffsetOf(ctx.node) }),
      ]),
    );
    this.produce(ctx, loaded, scalar);
  }

  protected selectStoreField(ctx: SelectionContext): void {
    const scalar = fieldScalarOf(ctx.node);
    const width = ctx.widthOf(scalar);
    const receiver = ctx.registerOf(ctx.node.inputs[0]!);
    const value = this.coerce(ctx, ctx.node.inputs[1]!, scalar);
    ctx.emit(
      instruction(this.storeFor(readOf(value)), [
        readOf(value),
        mem(width, { base: readOf(receiver), displacement: fieldOffsetOf(ctx.node) }),
      ]),
    );
    if (ctx.node.uses.length > 0) this.produce(ctx, value, scalar);
  }

  private displaced(
    ctx: SelectionContext,
    destination: VirtualRegister,
    base: VirtualRegister,
    offset: number,
  ): VirtualRegister {
    if (fitsImmediate(offset)) {
      ctx.emit(instruction("addi", [writeOf(destination), readOf(base), imm(offset)]));
      return destination;
    }
    const displacement = this.loadNumber(ctx, offset, SCALAR_INT32);
    ctx.emit(instruction("add", [writeOf(destination), readOf(base), readOf(displacement)]));
    return destination;
  }

  protected textAddress(ctx: SelectionContext, destination: VirtualRegister): VirtualRegister {
    const receiver = ctx.registerOf(ctx.node.inputs[0]!);
    return this.displaced(ctx, destination, receiver, fieldOffsetOf(ctx.node));
  }

  protected selectStoreText(ctx: SelectionContext): void {
    const value = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_STRING);
    const destination = this.textAddress(ctx, ctx.tempIn(RISCV_GPR, 8));
    const capacity = this.loadNumber(ctx, textCapacityOf(ctx.node), SCALAR_INT32);
    ctx.external(RISCV_RUNTIME_SYMBOLS.stringSet);
    ctx.emitCall(RISCV_RUNTIME_SYMBOLS.stringSet, [destination, capacity, value], null);
  }

  private elementPlace(ctx: SelectionContext): {
    element: AotScalar;
    base: VirtualRegister;
    address: Partial<MachineAddress>;
  } {
    const element = heapElementScalarOf(ctx.node)!;
    const width = ctx.widthOf(element);
    const receiver = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_POINTER);
    const scaled = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
    const base = ctx.tempIn(RISCV_GPR, TERA_POINTER_BYTES);
    ctx.emit(instruction("slli", [writeOf(base), readOf(scaled), imm(log2(width))]));
    ctx.emit(instruction("add", [writeOf(base), readOf(base), readOf(receiver)]));
    return { element, base, address: { displacement: fieldOffsetOf(ctx.node) } };
  }

  private elementTextAddress(
    ctx: SelectionContext,
    destination: VirtualRegister,
  ): VirtualRegister {
    const { base, address } = this.elementPlace(ctx);
    return this.displaced(ctx, destination, base, Number(address.displacement ?? 0));
  }

  protected selectLoadElement(ctx: SelectionContext): void {
    if (heapElementScalarOf(ctx.node) === SCALAR_TEXT) {
      const address = this.elementTextAddress(ctx, this.destination(ctx, SCALAR_STRING));
      this.produce(ctx, address, SCALAR_STRING);
      return;
    }
    const { element, base, address } = this.elementPlace(ctx);
    const width = ctx.widthOf(element);
    const loaded = this.destination(ctx, element);
    ctx.emit(
      instruction(this.loadFor(writeOf(loaded)), [
        writeOf(loaded),
        mem(width, { base: readOf(base), ...address }),
      ]),
    );
    this.produce(ctx, loaded, element);
  }

  protected selectStoreElement(ctx: SelectionContext): void {
    if (heapElementScalarOf(ctx.node) === SCALAR_TEXT) {
      const value = this.coerce(ctx, ctx.node.inputs[2]!, SCALAR_STRING);
      const destination = this.elementTextAddress(ctx, ctx.tempIn(RISCV_GPR, 8));
      const capacity = this.loadNumber(ctx, scalarWidth(SCALAR_TEXT), SCALAR_INT32);
      ctx.external(RISCV_RUNTIME_SYMBOLS.stringSet);
      ctx.emitCall(RISCV_RUNTIME_SYMBOLS.stringSet, [destination, capacity, value], null);
      return;
    }
    const { element, base, address } = this.elementPlace(ctx);
    const width = ctx.widthOf(element);
    const value = this.coerce(ctx, ctx.node.inputs[2]!, element);
    ctx.emit(
      instruction(this.storeFor(readOf(value)), [
        readOf(value),
        mem(width, { base: readOf(base), ...address }),
      ]),
    );
    if (ctx.node.uses.length > 0) this.produce(ctx, value, element);
  }

  protected selectCodeAddress(ctx: SelectionContext): void {
    const named = codeSymbolOf(ctx.node);
    if (named === null) return;
    const symbol = this.target.symbolOf(named);
    ctx.reference(symbol);
    ctx.emit(instruction("lla", [writeOf(ctx.resultRegister()), sym(symbol)]));
  }

  protected selectCallThrough(ctx: SelectionContext): void {
    const callee = ctx.registerOf(ctx.node.inputs[0]!);
    const signature = ctx.legality.codeSignatureOf(ctx.node.inputs[0]!)!;
    const args = callThroughArguments(ctx.node).map((input: CFGInstruction, index: number) =>
      this.coerce(ctx, input, nativeArgumentScalar(signature.params[index] ?? null, ctx.classes)),
    );
    ctx.emitCallThrough(callee, args, ctx.node.uses.length > 0 ? ctx.resultRegister() : null);
  }

  protected selectKnownCall(ctx: SelectionContext): void {
    const symbol = this.target.symbolOf(calleeSymbolName(ctx.node)!);
    const signature = calleeSignature(ctx.node);
    const args = ctx.node.inputs.map((input, index) =>
      this.coerce(ctx, input, nativeArgumentScalar(signature?.params[index] ?? null, ctx.classes)),
    );
    ctx.reference(symbol);
    ctx.emitCall(symbol, args, ctx.node.uses.length > 0 ? ctx.resultRegister() : null);
  }

  protected bufferAddress(ctx: SelectionContext, buffer: AotStringBuffer): VirtualRegister {
    const datum = ctx.data.intern(
      `string-buffer:${buffer.producer.id}`,
      1,
      zeroFilledBuffer(buffer.capacity),
      ".LB",
      true,
    );
    const address = ctx.temp(SCALAR_STRING);
    ctx.emit(instruction("lla", [writeOf(address), sym(datum.label)]));
    return address;
  }

  protected emitBufferCall(
    ctx: SelectionContext,
    symbol: string,
    buffer: AotStringBuffer,
    destination: VirtualRegister,
    operands: readonly VirtualRegister[],
  ): VirtualRegister {
    const capacity = this.loadNumber(ctx, buffer.capacity, SCALAR_INT32);
    const result = ctx.temp(SCALAR_STRING);
    ctx.external(symbol);
    ctx.emitCall(symbol, [destination, capacity, ...operands], result);
    return result;
  }

  protected selectStringConcat(ctx: SelectionContext): void {
    const buffer = this.requireStringBuffer(ctx);
    const left = ctx.registerOf(ctx.node.inputs[0]!);
    const right = ctx.registerOf(ctx.node.inputs[1]!);
    const initialized = this.emitBufferCall(
      ctx,
      RISCV_RUNTIME_SYMBOLS.stringSet,
      buffer,
      this.bufferAddress(ctx, buffer),
      [left],
    );
    const appended = this.emitBufferCall(
      ctx,
      RISCV_RUNTIME_SYMBOLS.stringAppend,
      buffer,
      initialized,
      [right],
    );
    this.produce(ctx, appended, SCALAR_STRING);
  }

  private selectPrint(ctx: SelectionContext): void {
    const arity = ctx.node.inputs.length;
    ctx.node.inputs.forEach((value, index) => {
      const scalar = ctx.scalarOf(value);
      const symbol = PRINT_ROUTINES.get(scalar);
      if (symbol === undefined) {
        throw new BackendLoweringError(`riscv64 backend cannot print a ${scalar} value`);
      }
      const operand = this.coerce(ctx, value, scalar);
      const terminator = this.loadNumber(
        ctx,
        printTerminatorAt(index, arity),
        SCALAR_INT32,
      );
      ctx.external(symbol);
      ctx.emitCall(symbol, [operand, terminator], null);
    });
  }

  private selectThrow(ctx: SelectionContext): void {
    const message = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_STRING);
    ctx.external(RISCV_RUNTIME_SYMBOLS.throwError);
    ctx.emitCall(RISCV_RUNTIME_SYMBOLS.throwError, [message], null);
  }

  protected selectBuiltin(ctx: SelectionContext): void {
    const name = String(ctx.node.props.name);
    if (name === PRINT_BUILTIN) {
      this.selectPrint(ctx);
      return;
    }
    if (name === THROW_BUILTIN) {
      this.selectThrow(ctx);
      return;
    }
    const buffered = STRING_BUFFER_BUILTINS.get(name);
    if (buffered !== undefined) {
      this.selectStringBuffered(ctx, buffered);
      return;
    }
    const intrinsic = builtinIntrinsicByName(name)!;
    const args = ctx.node.inputs.map((input, index) =>
      this.coerce(ctx, input, nativeArgumentScalar(builtinParameterAt(intrinsic, index), ctx.classes)),
    );
    const scalar = ctx.scalarOf(ctx.node);

    if (name === qualifiedMethodName("Math", "sqrt")) {
      const result = this.destination(ctx, SCALAR_FLOAT64);
      ctx.emit(instruction("fsqrt.d", [writeOf(result), readOf(args[0]!)]));
      this.produce(ctx, result, SCALAR_FLOAT64);
      return;
    }
    if (name === qualifiedMethodName("Math", "abs")) {
      const result = this.destination(ctx, SCALAR_FLOAT64);
      ctx.emit(instruction("fabs.d", [writeOf(result), readOf(args[0]!)]));
      this.produce(ctx, result, SCALAR_FLOAT64);
      return;
    }
    if (name === qualifiedMethodName("Math", "round")) {
      const half = this.loadNumber(ctx, 0.5, SCALAR_FLOAT64);
      const shifted = ctx.temp(SCALAR_FLOAT64);
      ctx.emit(
        instruction("fadd.d", [writeOf(shifted), readOf(args[0]!), readOf(half)]),
      );
      this.emitLibraryCall(ctx, RISCV_RUNTIME_SYMBOLS.floor, [shifted], scalar);
      return;
    }
    if (name === qualifiedMethodName("string", "length")) {
      this.emitLibraryCall(ctx, RISCV_RUNTIME_SYMBOLS.stringLength, args, scalar);
      return;
    }
    const libm = LIBM_CALLS.get(name);
    if (libm !== undefined) {
      this.emitLibraryCall(ctx, libm, args, scalar);
      return;
    }
    const runtime = RUNTIME_BUILTINS.get(name);
    if (runtime === undefined) {
      throw new BackendLoweringError(
        `riscv64 backend has no lowering for admitted builtin ${name}`,
      );
    }
    this.emitLibraryCall(ctx, runtime, args, scalar);
  }

}

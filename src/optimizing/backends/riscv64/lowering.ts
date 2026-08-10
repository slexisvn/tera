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
  IR_LOAD_ARRAY_LENGTH,
  IR_LOAD_ELEMENT,
  IR_LOAD_GLOBAL,
  IR_NEG,
  IR_NEW_ARRAY,
  IR_NOT,
  IR_RETURN,
  IR_STORE_ELEMENT,
} from "../../ir/index.js";
import { calleeSymbolName } from "../../analyses/aot-legality.js";
import type { DeclaredSignature } from "../../types/signature.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  type AotScalar,
} from "../../types/scalar.js";
import { builtinIntrinsicByName, qualifiedMethodName } from "../../metadata/builtin-methods.js";
import { BackendLoweringError } from "../../target/errors.js";
import {
  def,
  imm,
  instruction,
  label,
  mem,
  sym,
  use,
  type MachineBlock,
  type MachineInstruction,
  type MachineOperand,
  type RegisterOperand,
  type StackSlot,
  type VirtualRegister,
} from "../../machine/ir.js";
import type {
  MachineLowering,
  SelectionContext,
  SelectionHandler,
} from "../../machine/lowering.js";
import { fusedConditionOf } from "../../machine/select.js";
import { nativeArgumentScalar, nativeReturnScalar } from "../../machine/signature.js";
import { RISCV_FPR, RISCV_GPR } from "./registers.js";
import { RISCV_RUNTIME_SYMBOLS } from "./runtime.js";
import type { RiscvTargetModel } from "./target.js";

interface IntCondition {
  readonly branch: string;
  readonly swap: boolean;
  readonly negate: boolean;
  readonly equality: boolean;
}

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

const INT_HELPERS = new Map<string, string>([
  [IR_INT32_DIV, RISCV_RUNTIME_SYMBOLS.divide],
  [IR_INT32_MOD, RISCV_RUNTIME_SYMBOLS.modulo],
]);

const LIBM_CALLS = new Map<string, string>([
  [qualifiedMethodName("Math", "floor"), "floor"],
  [qualifiedMethodName("Math", "ceil"), "ceil"],
  [qualifiedMethodName("Math", "trunc"), "trunc"],
]);

const RUNTIME_BUILTINS = new Map<string, string>([
  [qualifiedMethodName("Math", "min"), RISCV_RUNTIME_SYMBOLS.minimum],
  [qualifiedMethodName("Math", "max"), RISCV_RUNTIME_SYMBOLS.maximum],
  [qualifiedMethodName("string", "char_code_at"), RISCV_RUNTIME_SYMBOLS.charCodeAt],
]);

const SHIFT_MASK = 31;

function doubleBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return `0x${view.getBigUint64(0).toString(16).padStart(16, "0")}`;
}

function asciiLiteral(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"' || character === "\\") out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

function calleeSignature(node: CFGInstruction): DeclaredSignature | null {
  const target = node.props.target as { declaredSignature?: DeclaredSignature } | undefined;
  return target?.declaredSignature ?? null;
}

function readOf(register: VirtualRegister): RegisterOperand {
  return use(register, register.width);
}

function writeOf(register: VirtualRegister): RegisterOperand {
  return def(register, register.width);
}

function log2(value: number): number {
  return Math.round(Math.log2(value));
}

export class RiscvLowering implements MachineLowering {
  constructor(readonly target: RiscvTargetModel) {}

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
      [IR_NEW_ARRAY, (ctx) => this.selectNewArray(ctx)],
      [IR_LOAD_ELEMENT, (ctx) => this.selectLoadElement(ctx)],
      [IR_GENERIC_GET_INDEX, (ctx) => this.selectLoadElement(ctx)],
      [IR_STORE_ELEMENT, (ctx) => this.selectStoreElement(ctx)],
      [IR_GENERIC_SET_INDEX, (ctx) => this.selectStoreElement(ctx)],
      [IR_LOAD_ARRAY_LENGTH, (ctx) => this.selectArrayLength(ctx)],
      [IR_CALL_KNOWN_FUNCTION, (ctx) => this.selectKnownCall(ctx)],
      [IR_CALL_BUILTIN, (ctx) => this.selectBuiltin(ctx)],
    ];
    for (const [opcode, mnemonic] of FLOAT_BINARY) {
      entries.push([opcode, (ctx) => this.selectFloatBinary(ctx, mnemonic)]);
    }
    for (const [opcode, mnemonic] of INT_BINARY) {
      entries.push([opcode, (ctx) => this.selectIntBinary(ctx, mnemonic)]);
    }
    for (const [opcode, mnemonic] of INT_SHIFT) {
      entries.push([opcode, (ctx) => this.selectShift(ctx, mnemonic)]);
    }
    for (const [opcode, symbol] of INT_HELPERS) {
      entries.push([opcode, (ctx) => this.selectIntHelper(ctx, symbol)]);
    }
    return entries;
  }

  materialize(ctx: SelectionContext, constant: CFGInstruction): VirtualRegister {
    const scalar = ctx.scalarOf(constant);
    const value = constant.props.value;
    if (scalar === SCALAR_STRING) {
      const text = String(value);
      const datum = ctx.data.intern(
        `string:${text}`,
        1,
        () => [`\t.asciz ${asciiLiteral(text)}`],
        ".LS",
      );
      const destination = ctx.temp(scalar);
      ctx.emit(instruction("lla", [writeOf(destination), sym(datum.label)]));
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

  loadIncoming(destination: RegisterOperand, slot: StackSlot): MachineInstruction {
    return this.reload(destination, slot);
  }

  storeOutgoing(offset: number, source: RegisterOperand): MachineInstruction {
    return instruction(this.storeFor(source), [
      source,
      mem(source.width, { base: this.stackPointer(), displacement: offset }),
    ]);
  }

  jump(target: MachineBlock): MachineInstruction {
    return instruction("j", [label(target)], { terminator: true });
  }

  call(symbol: string, operands: MachineOperand[]): MachineInstruction {
    return instruction("call", [sym(symbol), ...operands], {
      call: true,
      implicitFrom: 1,
    });
  }

  loadFor(operand: RegisterOperand): string {
    if (operand.register.classId === RISCV_FPR) return "fld";
    return operand.width === 8 ? "ld" : "lw";
  }

  storeFor(operand: RegisterOperand): string {
    if (operand.register.classId === RISCV_FPR) return "fsd";
    return operand.width === 8 ? "sd" : "sw";
  }

  private stackPointer(): RegisterOperand {
    return use(this.target.abi.stackPointer, 8);
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
    const bits = doubleBits(value);
    const datum = ctx.data.intern(`double:${bits}`, 8, () => [`\t.quad ${bits}`]);
    const address = ctx.tempIn(RISCV_GPR, 8);
    ctx.emit(instruction("lla", [writeOf(address), sym(datum.label)]));
    ctx.emit(
      instruction("fld", [writeOf(into), mem(8, { base: readOf(address) })]),
    );
    return into;
  }

  private coerce(
    ctx: SelectionContext,
    value: CFGInstruction,
    scalar: AotScalar,
  ): VirtualRegister {
    return this.convert(ctx, ctx.registerOf(value), ctx.scalarOf(value), scalar);
  }

  private destination(ctx: SelectionContext, scalar: AotScalar): VirtualRegister {
    return ctx.scalarOf(ctx.node) === scalar ? ctx.resultRegister() : ctx.temp(scalar);
  }

  private produce(
    ctx: SelectionContext,
    value: VirtualRegister,
    scalar: AotScalar,
  ): void {
    const wanted = ctx.scalarOf(ctx.node);
    if (scalar === wanted && value === ctx.resultRegister()) return;
    const converted = this.convert(ctx, value, scalar, wanted);
    ctx.emit(this.copy(ctx.resultOf(), readOf(converted)));
  }

  private selectFloatBinary(ctx: SelectionContext, mnemonic: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_FLOAT64);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_FLOAT64);
    const result = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(instruction(mnemonic, [writeOf(result), readOf(left), readOf(right)]));
    this.produce(ctx, result, SCALAR_FLOAT64);
  }

  private selectIntBinary(ctx: SelectionContext, mnemonic: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.emit(
      instruction(mnemonic, [writeOf(result), readOf(left), readOf(right)]),
    );
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectIntNot(ctx: SelectionContext): void {
    const operand = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.emit(instruction("xori", [writeOf(result), readOf(operand), imm(-1)]));
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectShift(ctx: SelectionContext, mnemonic: string): void {
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

  private selectIntHelper(ctx: SelectionContext, symbol: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.external(symbol);
    ctx.emitCall(symbol, [left, right], result);
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectNegate(ctx: SelectionContext): void {
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

  private selectLogicalNot(ctx: SelectionContext): void {
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

  private selectIntCompare(ctx: SelectionContext): void {
    const condition = this.intCondition(String(ctx.node.props.op));
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
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

  private selectFloatCompare(ctx: SelectionContext): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_FLOAT64);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_FLOAT64);
    const result = this.destination(ctx, SCALAR_INT32);
    this.emitFloatCondition(ctx, String(ctx.node.props.op), left, right, result);
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectBranch(ctx: SelectionContext): void {
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

  private selectReturn(ctx: SelectionContext): void {
    const scalar = nativeReturnScalar(ctx.legality);
    const value = this.coerce(ctx, ctx.node.inputs[0]!, scalar);
    const width = ctx.widthOf(scalar);
    const returned = this.target.abi.callingConvention.returnRegisters.get(
      ctx.classOf(scalar),
    )!;
    ctx.emit(this.copy(def(returned, width), use(value, width)));
    ctx.emit(
      instruction("ret", [use(returned, width)], { terminator: true, implicitFrom: 0 }),
    );
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

  private selectNewArray(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node)!;
    const slot = ctx.slotOf(array);
    const width = ctx.widthOf(array.element);
    const base = this.elementAddress(ctx, width, null);
    if (ctx.node.inputs.length === 0) {
      const zero = this.loadNumber(ctx, 0, array.element);
      ctx.emit(
        instruction(this.storeFor(readOf(zero)), [
          readOf(zero),
          mem(width, { base: readOf(base), slot }),
        ]),
      );
      return;
    }
    for (let index = 0; index < ctx.node.inputs.length; index++) {
      const value = this.coerce(ctx, ctx.node.inputs[index]!, array.element);
      ctx.emit(
        instruction(this.storeFor(readOf(value)), [
          readOf(value),
          mem(width, { base: readOf(base), slot, displacement: index * width }),
        ]),
      );
    }
  }

  private selectLoadElement(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node.inputs[0]!)!;
    const slot = ctx.slotOf(array);
    const width = ctx.widthOf(array.element);
    const base = this.elementAddress(ctx, width, ctx.node.inputs[1]!);
    const loaded = this.destination(ctx, array.element);
    ctx.emit(
      instruction(this.loadFor(writeOf(loaded)), [
        writeOf(loaded),
        mem(width, { base: readOf(base), slot }),
      ]),
    );
    this.produce(ctx, loaded, array.element);
  }

  private selectStoreElement(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node.inputs[0]!)!;
    const slot = ctx.slotOf(array);
    const width = ctx.widthOf(array.element);
    const base = this.elementAddress(ctx, width, ctx.node.inputs[1]!);
    const value = this.coerce(ctx, ctx.node.inputs[2]!, array.element);
    ctx.emit(
      instruction(this.storeFor(readOf(value)), [
        readOf(value),
        mem(width, { base: readOf(base), slot }),
      ]),
    );
    if (ctx.node.uses.length > 0) this.produce(ctx, value, array.element);
  }

  private selectArrayLength(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node.inputs[0]!)!;
    this.loadNumber(ctx, array.length, ctx.scalarOf(ctx.node), ctx.resultRegister());
  }

  private selectKnownCall(ctx: SelectionContext): void {
    const symbol = this.target.symbolOf(calleeSymbolName(ctx.node)!);
    const signature = calleeSignature(ctx.node);
    const args = ctx.node.inputs.map((input, index) =>
      this.coerce(ctx, input, nativeArgumentScalar(signature?.params[index] ?? null)),
    );
    ctx.reference(symbol);
    ctx.emitCall(symbol, args, ctx.node.uses.length > 0 ? ctx.resultRegister() : null);
  }

  private selectBuiltin(ctx: SelectionContext): void {
    const name = String(ctx.node.props.name);
    const intrinsic = builtinIntrinsicByName(name)!;
    const args = ctx.node.inputs.map((input, index) =>
      this.coerce(ctx, input, nativeArgumentScalar(intrinsic.signature.params[index] ?? null)),
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
      this.emitLibraryCall(ctx, "floor", [shifted], scalar);
      return;
    }
    if (name === qualifiedMethodName("string", "length")) {
      this.emitLibraryCall(ctx, "strlen", args, scalar);
      return;
    }
    const libm = LIBM_CALLS.get(name);
    if (libm !== undefined) {
      this.emitLibraryCall(ctx, libm, args, scalar);
      return;
    }
    const runtime = RUNTIME_BUILTINS.get(name);
    if (runtime === undefined) {
      throw new Error(`riscv64 backend has no lowering for admitted builtin ${name}`);
    }
    this.emitLibraryCall(ctx, runtime, args, scalar);
  }

  private emitLibraryCall(
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

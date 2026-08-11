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
import {
  AOT_CHAR_AT,
  AOT_INT_TO_STRING,
  calleeSymbolName,
  type AotStringBuffer,
} from "../../analyses/aot-legality.js";
import { zeroFilledBuffer } from "../../machine/data.js";
import { latticeFromDeclaredType } from "../../types/declared.js";
import type { DeclaredSignature } from "../../types/signature.js";
import {
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  type AotScalar,
} from "../../types/scalar.js";
import { builtinIntrinsicByName, qualifiedMethodName } from "../../metadata/builtin-methods.js";
import { BackendLoweringError } from "../../target/errors.js";
import type { PhysicalRegister } from "../../target/registers.js";
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
import { X64_FPR, X64_GPR } from "./registers.js";
import {
  ABS_MASK_KEY,
  SIGN_MASK_KEY,
  X64_RUNTIME_SYMBOLS,
  x64MaskDirectives,
} from "./runtime.js";
import type { X64TargetModel } from "./target.js";

const INT_CONDITIONS = new Map<string, string>([
  ["<", "l"],
  ["<=", "le"],
  [">", "g"],
  [">=", "ge"],
  ["==", "e"],
  ["loose==", "e"],
  ["!=", "ne"],
  ["loose!=", "ne"],
]);

interface FloatCondition {
  readonly swap: boolean;
  readonly code: string;
  readonly parity: string | null;
  readonly combine: string | null;
}

const FLOAT_CONDITIONS = new Map<string, FloatCondition>([
  ["<", { swap: true, code: "a", parity: null, combine: null }],
  ["<=", { swap: true, code: "ae", parity: null, combine: null }],
  [">", { swap: false, code: "a", parity: null, combine: null }],
  [">=", { swap: false, code: "ae", parity: null, combine: null }],
  ["==", { swap: false, code: "e", parity: "np", combine: "andl" }],
  ["loose==", { swap: false, code: "e", parity: "np", combine: "andl" }],
  ["!=", { swap: false, code: "ne", parity: "p", combine: "orl" }],
  ["loose!=", { swap: false, code: "ne", parity: "p", combine: "orl" }],
]);

const FLOAT_BINARY = new Map<string, string>([
  [IR_FLOAT64_ADD, "addsd"],
  [IR_FLOAT64_SUB, "subsd"],
  [IR_FLOAT64_MUL, "mulsd"],
  [IR_FLOAT64_DIV, "divsd"],
]);

const INT_BINARY = new Map<string, string>([
  [IR_INT32_AND, "andl"],
  [IR_INT32_OR, "orl"],
  [IR_INT32_XOR, "xorl"],
  [IR_INT32_MUL, "imull"],
]);

const INT_SHIFT = new Map<string, string>([
  [IR_INT32_SHL, "sall"],
  [IR_INT32_SHR, "sarl"],
  [IR_INT32_USHR, "shrl"],
]);

const INT_HELPERS = new Map<string, string>([
  [IR_INT32_DIV, X64_RUNTIME_SYMBOLS.divide],
  [IR_INT32_MOD, X64_RUNTIME_SYMBOLS.modulo],
]);

const LIBM_CALLS = new Map<string, string>([
  [qualifiedMethodName("Math", "floor"), "floor"],
  [qualifiedMethodName("Math", "ceil"), "ceil"],
  [qualifiedMethodName("Math", "trunc"), "trunc"],
]);

const RUNTIME_BUILTINS = new Map<string, string>([
  [qualifiedMethodName("Math", "min"), X64_RUNTIME_SYMBOLS.minimum],
  [qualifiedMethodName("Math", "max"), X64_RUNTIME_SYMBOLS.maximum],
  [qualifiedMethodName("string", "char_code_at"), X64_RUNTIME_SYMBOLS.charCodeAt],
]);

const STRING_BUFFER_BUILTINS = new Map<string, string>([
  [AOT_CHAR_AT, X64_RUNTIME_SYMBOLS.charAt],
  [AOT_INT_TO_STRING, X64_RUNTIME_SYMBOLS.int32ToString],
]);

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
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

export class X64Lowering implements MachineLowering {
  constructor(readonly target: X64TargetModel) {}

  rules(): Iterable<readonly [string, SelectionHandler]> {
    const entries: Array<readonly [string, SelectionHandler]> = [
      [IR_LOAD_GLOBAL, () => undefined],
      [IR_RETURN, (ctx) => this.selectReturn(ctx)],
      [IR_JUMP, (ctx) => void ctx.emit(this.jump(ctx.successorFor("targetBlock")))],
      [IR_BRANCH, (ctx) => this.selectBranch(ctx)],
      [IR_INT32_ADD, (ctx) => this.selectIntAdd(ctx)],
      [IR_INT32_SUB, (ctx) => this.selectIntSub(ctx)],
      [IR_INT32_NOT, (ctx) => this.selectIntNot(ctx)],
      [IR_INT32_COMPARE, (ctx) => this.selectCompare(ctx, false)],
      [IR_FLOAT64_COMPARE, (ctx) => this.selectCompare(ctx, true)],
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
      [IR_GENERIC_ADD, (ctx) => this.selectStringConcat(ctx)],
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
      ctx.emit(
        instruction("leaq", [writeOf(destination), mem(8, { symbol: datum.label })]),
      );
      return destination;
    }
    return this.loadNumber(ctx, Number(value), scalar);
  }

  copy(destination: RegisterOperand, source: RegisterOperand): MachineInstruction {
    return instruction(this.moveFor(destination), [destination, source], { copy: true });
  }

  reload(destination: RegisterOperand, slot: StackSlot): MachineInstruction {
    return instruction(this.moveFor(destination), [
      destination,
      mem(destination.width, { base: this.stackPointer(), slot }),
    ]);
  }

  spill(slot: StackSlot, source: RegisterOperand): MachineInstruction {
    return instruction(this.moveFor(source), [
      mem(source.width, { base: this.stackPointer(), slot }),
      source,
    ]);
  }

  loadIncoming(destination: RegisterOperand, slot: StackSlot): MachineInstruction {
    return this.reload(destination, slot);
  }

  storeOutgoing(offset: number, source: RegisterOperand): MachineInstruction {
    return instruction(this.moveFor(source), [
      mem(source.width, { base: this.stackPointer(), displacement: offset }),
      source,
    ]);
  }

  jump(target: MachineBlock): MachineInstruction {
    return instruction("jmp", [label(target)], { terminator: true });
  }

  call(symbol: string, operands: MachineOperand[]): MachineInstruction {
    return instruction("call", [sym(symbol), ...operands], {
      call: true,
      implicitFrom: 1,
    });
  }

  private stackPointer(): RegisterOperand {
    return use(this.target.abi.stackPointer, 8);
  }

  private moveFor(operand: RegisterOperand): string {
    if (operand.register.classId === X64_FPR) return "movsd";
    return operand.width === 8 ? "movq" : "movl";
  }

  private loadNumber(
    ctx: SelectionContext,
    value: number,
    scalar: AotScalar,
    into: VirtualRegister = ctx.temp(scalar),
  ): VirtualRegister {
    if (scalar === SCALAR_INT32) {
      ctx.emit(instruction("movl", [writeOf(into), imm(value | 0)]));
      return into;
    }
    const bits = doubleBits(value);
    const datum = ctx.data.intern(`double:${bits}`, 8, () => [`\t.quad ${bits}`]);
    ctx.emit(instruction("movsd", [writeOf(into), mem(8, { symbol: datum.label })]));
    return into;
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
      ctx.emit(instruction("cvtsi2sdl", [writeOf(destination), readOf(source)]));
      return destination;
    }
    ctx.external(X64_RUNTIME_SYMBOLS.toInt32);
    ctx.emitCall(X64_RUNTIME_SYMBOLS.toInt32, [source], destination);
    return destination;
  }

  private coerce(
    ctx: SelectionContext,
    value: CFGInstruction,
    scalar: AotScalar,
  ): VirtualRegister {
    return this.convert(ctx, ctx.registerOf(value), ctx.scalarOf(value), scalar);
  }

  private intConstantOf(ctx: SelectionContext, value: CFGInstruction): number | null {
    if (ctx.scalarOf(value) !== SCALAR_INT32) return null;
    const constant = ctx.constantOf(value);
    if (typeof constant === "boolean") return constant ? 1 : 0;
    if (typeof constant !== "number" || !Number.isInteger(constant)) return null;
    return constant < INT32_MIN || constant > INT32_MAX ? null : constant;
  }

  private index(ctx: SelectionContext, value: CFGInstruction): VirtualRegister {
    const narrow = this.coerce(ctx, value, SCALAR_INT32);
    const wide = ctx.tempIn(X64_GPR, 8);
    ctx.emit(instruction("movslq", [writeOf(wide), readOf(narrow)]));
    return wide;
  }

  private selectFloatBinary(ctx: SelectionContext, mnemonic: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_FLOAT64);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_FLOAT64);
    const result = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(
      instruction(mnemonic, [writeOf(result), readOf(left), readOf(right)], { tied: true }),
    );
    this.produce(ctx, result, SCALAR_FLOAT64);
  }

  private selectIntBinary(ctx: SelectionContext, mnemonic: string): void {
    const left = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.emit(
      instruction(mnemonic, [writeOf(result), readOf(left), readOf(right)], { tied: true }),
    );
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectIntAdd(ctx: SelectionContext): void {
    const result = this.destination(ctx, SCALAR_INT32);
    const left = ctx.node.inputs[0]!;
    const right = ctx.node.inputs[1]!;
    const constant = this.intConstantOf(ctx, right) ?? this.intConstantOf(ctx, left);
    const variable = this.intConstantOf(ctx, right) === null ? right : left;
    if (constant !== null && this.intConstantOf(ctx, variable) === null) {
      const base = this.coerce(ctx, variable, SCALAR_INT32);
      ctx.emit(
        instruction("leal", [
          writeOf(result),
          mem(4, { base: use(base, 8), displacement: constant }),
        ]),
      );
    } else {
      const base = this.coerce(ctx, left, SCALAR_INT32);
      const index = this.coerce(ctx, right, SCALAR_INT32);
      ctx.emit(
        instruction("leal", [
          writeOf(result),
          mem(4, { base: use(base, 8), index: use(index, 8), scale: 1 }),
        ]),
      );
    }
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectIntSub(ctx: SelectionContext): void {
    const result = this.destination(ctx, SCALAR_INT32);
    const left = ctx.node.inputs[0]!;
    const right = ctx.node.inputs[1]!;
    const constant = this.intConstantOf(ctx, right);
    if (constant !== null && constant !== INT32_MIN) {
      const base = this.coerce(ctx, left, SCALAR_INT32);
      ctx.emit(
        instruction("leal", [
          writeOf(result),
          mem(4, { base: use(base, 8), displacement: -constant }),
        ]),
      );
    } else {
      const lhs = this.coerce(ctx, left, SCALAR_INT32);
      const rhs = this.coerce(ctx, right, SCALAR_INT32);
      ctx.emit(
        instruction("subl", [writeOf(result), readOf(lhs), readOf(rhs)], { tied: true }),
      );
    }
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectIntNot(ctx: SelectionContext): void {
    const operand = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.emit(instruction("notl", [writeOf(result), readOf(operand)], { tied: true }));
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectShift(ctx: SelectionContext, mnemonic: string): void {
    const value = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
    const amount = ctx.node.inputs[1]!;
    const constant = this.intConstantOf(ctx, amount);
    const wide = mnemonic === "shrl" && ctx.scalarOf(ctx.node) === SCALAR_FLOAT64;
    const result = wide ? ctx.tempIn(X64_GPR, 8) : this.destination(ctx, SCALAR_INT32);
    const destination = def(result, 4);
    if (constant !== null) {
      ctx.emit(
        instruction(mnemonic, [destination, use(value, 4), imm(constant & SHIFT_MASK)], {
          tied: true,
        }),
      );
    } else {
      const count = this.coerce(ctx, amount, SCALAR_INT32);
      ctx.emit(this.copy(def(this.shiftCounter(), 4), readOf(count)));
      ctx.emit(
        instruction(
          mnemonic,
          [destination, use(value, 4), use(this.shiftCounter(), 1)],
          { tied: true },
        ),
      );
    }
    if (!wide) {
      this.produce(ctx, result, SCALAR_INT32);
      return;
    }
    const converted = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(instruction("cvtsi2sdq", [writeOf(converted), use(result, 8)]));
    this.produce(ctx, converted, SCALAR_FLOAT64);
  }

  private shiftCounter(): PhysicalRegister {
    return this.target.registers.register("rcx");
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
    const scalar = ctx.scalarOf(ctx.node);
    if (scalar === SCALAR_INT32) {
      const operand = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_INT32);
      const result = this.destination(ctx, SCALAR_INT32);
      ctx.emit(instruction("negl", [writeOf(result), readOf(operand)], { tied: true }));
      this.produce(ctx, result, SCALAR_INT32);
      return;
    }
    const operand = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_FLOAT64);
    const mask = ctx.data.intern(SIGN_MASK_KEY, 16, () => x64MaskDirectives(SIGN_MASK_KEY));
    const result = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(
      instruction(
        "xorpd",
        [writeOf(result), readOf(operand), mem(16, { symbol: mask.label })],
        { tied: true },
      ),
    );
    this.produce(ctx, result, SCALAR_FLOAT64);
  }

  private selectLogicalNot(ctx: SelectionContext): void {
    const operand = ctx.node.inputs[0]!;
    const scalar = ctx.scalarOf(operand);
    const result = this.destination(ctx, SCALAR_INT32);
    if (scalar === SCALAR_FLOAT64) {
      const zero = this.loadNumber(ctx, 0, SCALAR_FLOAT64);
      this.emitFloatCondition(ctx, "==", ctx.registerOf(operand), zero, result);
    } else {
      const value = ctx.registerOf(operand);
      ctx.emit(instruction(this.testFor(value), [readOf(value), readOf(value)]));
      this.emitSetCondition(ctx, "e", result);
    }
    this.produce(ctx, result, SCALAR_INT32);
  }

  private testFor(register: VirtualRegister): string {
    return register.width === 8 ? "testq" : "testl";
  }

  private emitSetCondition(
    ctx: SelectionContext,
    code: string,
    destination: VirtualRegister,
  ): void {
    ctx.emit(instruction(`set${code}`, [def(destination, 1)]));
    ctx.emit(instruction("movzbl", [def(destination, 4), use(destination, 1)]));
  }

  private emitIntComparison(
    ctx: SelectionContext,
    operation: string,
    left: VirtualRegister,
    right: VirtualRegister,
  ): string {
    const code = INT_CONDITIONS.get(operation);
    if (code === undefined) {
      throw new BackendLoweringError(`unsupported comparison ${operation}`);
    }
    ctx.emit(instruction("cmpl", [use(left, 4), use(right, 4)]));
    return code;
  }

  private emitFloatComparison(
    ctx: SelectionContext,
    operation: string,
    left: VirtualRegister,
    right: VirtualRegister,
  ): FloatCondition {
    const condition = FLOAT_CONDITIONS.get(operation);
    if (condition === undefined) {
      throw new BackendLoweringError(`unsupported comparison ${operation}`);
    }
    const ordered = condition.swap ? [right, left] : [left, right];
    ctx.emit(instruction("ucomisd", [use(ordered[0]!, 8), use(ordered[1]!, 8)]));
    return condition;
  }

  private emitFloatCondition(
    ctx: SelectionContext,
    operation: string,
    left: VirtualRegister,
    right: VirtualRegister,
    destination: VirtualRegister,
  ): void {
    const condition = this.emitFloatComparison(ctx, operation, left, right);
    ctx.emit(instruction(`set${condition.code}`, [def(destination, 1)]));
    if (condition.parity === null) {
      ctx.emit(instruction("movzbl", [def(destination, 4), use(destination, 1)]));
      return;
    }
    const parity = ctx.temp(SCALAR_INT32);
    ctx.emit(instruction(`set${condition.parity}`, [def(parity, 1)]));
    ctx.emit(instruction("movzbl", [def(destination, 4), use(destination, 1)]));
    ctx.emit(instruction("movzbl", [def(parity, 4), use(parity, 1)]));
    ctx.emit(
      instruction(
        condition.combine!,
        [def(destination, 4), use(destination, 4), use(parity, 4)],
        { tied: true },
      ),
    );
  }

  private selectCompare(ctx: SelectionContext, float: boolean): void {
    const operation = String(ctx.node.props.op);
    const scalar = float ? SCALAR_FLOAT64 : SCALAR_INT32;
    const left = this.coerce(ctx, ctx.node.inputs[0]!, scalar);
    const right = this.coerce(ctx, ctx.node.inputs[1]!, scalar);
    const result = this.destination(ctx, SCALAR_INT32);
    if (float) {
      this.emitFloatCondition(ctx, operation, left, right, result);
    } else {
      const code = this.emitIntComparison(ctx, operation, left, right);
      this.emitSetCondition(ctx, code, result);
    }
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectBranch(ctx: SelectionContext): void {
    const onTrue = ctx.successorFor("trueBlock");
    const onFalse = ctx.successorFor("falseBlock");
    const fused = fusedConditionOf(ctx);
    if (fused !== null && fused.type === IR_FLOAT64_COMPARE) {
      const left = this.coerce(ctx, fused.inputs[0]!, SCALAR_FLOAT64);
      const right = this.coerce(ctx, fused.inputs[1]!, SCALAR_FLOAT64);
      const condition = this.emitFloatComparison(ctx, String(fused.props.op), left, right);
      if (condition.parity === "np") ctx.emit(instruction("jp", [label(onFalse)]));
      if (condition.parity === "p") ctx.emit(instruction("jp", [label(onTrue)]));
      ctx.emit(instruction(`j${condition.code}`, [label(onTrue)]));
    } else if (fused !== null) {
      const left = this.coerce(ctx, fused.inputs[0]!, SCALAR_INT32);
      const right = this.coerce(ctx, fused.inputs[1]!, SCALAR_INT32);
      const code = this.emitIntComparison(ctx, String(fused.props.op), left, right);
      ctx.emit(instruction(`j${code}`, [label(onTrue)]));
    } else {
      const condition = ctx.node.inputs[0]!;
      if (ctx.scalarOf(condition) === SCALAR_FLOAT64) {
        const zero = this.loadNumber(ctx, 0, SCALAR_FLOAT64);
        this.emitFloatComparison(ctx, "!=", ctx.registerOf(condition), zero);
        ctx.emit(instruction("jp", [label(onTrue)]));
        ctx.emit(instruction("jne", [label(onTrue)]));
      } else {
        const value = ctx.registerOf(condition);
        ctx.emit(instruction(this.testFor(value), [readOf(value), readOf(value)]));
        ctx.emit(instruction("jne", [label(onTrue)]));
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
      instruction("ret", [use(returned, width)], {
        terminator: true,
        implicitFrom: 0,
      }),
    );
  }

  private elementAddress(
    ctx: SelectionContext,
    slot: StackSlot,
    width: number,
    index: VirtualRegister | null,
    element: number,
  ) {
    return mem(width, {
      base: this.stackPointer(),
      index: index === null ? null : use(index, 8),
      scale: width,
      displacement: element * width,
      slot,
    });
  }

  private selectNewArray(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node)!;
    const slot = ctx.slotOf(array);
    const width = ctx.widthOf(array.element);
    if (ctx.node.inputs.length === 0) {
      const zero = this.loadNumber(ctx, 0, array.element);
      ctx.emit(
        instruction(this.moveFor(readOf(zero)), [
          this.elementAddress(ctx, slot, width, null, 0),
          use(zero, width),
        ]),
      );
      return;
    }
    for (let index = 0; index < ctx.node.inputs.length; index++) {
      const value = this.coerce(ctx, ctx.node.inputs[index]!, array.element);
      ctx.emit(
        instruction(this.moveFor(readOf(value)), [
          this.elementAddress(ctx, slot, width, null, index),
          use(value, width),
        ]),
      );
    }
  }

  private selectLoadElement(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node.inputs[0]!)!;
    const slot = ctx.slotOf(array);
    const width = ctx.widthOf(array.element);
    const index = this.index(ctx, ctx.node.inputs[1]!);
    const loaded = this.destination(ctx, array.element);
    ctx.emit(
      instruction(this.moveFor(writeOf(loaded)), [
        def(loaded, width),
        this.elementAddress(ctx, slot, width, index, 0),
      ]),
    );
    this.produce(ctx, loaded, array.element);
  }

  private selectStoreElement(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node.inputs[0]!)!;
    const slot = ctx.slotOf(array);
    const width = ctx.widthOf(array.element);
    const index = this.index(ctx, ctx.node.inputs[1]!);
    const value = this.coerce(ctx, ctx.node.inputs[2]!, array.element);
    ctx.emit(
      instruction(this.moveFor(readOf(value)), [
        this.elementAddress(ctx, slot, width, index, 0),
        use(value, width),
      ]),
    );
    if (ctx.node.uses.length > 0) this.produce(ctx, value, array.element);
  }

  private selectArrayLength(ctx: SelectionContext): void {
    const array = ctx.arrayOf(ctx.node.inputs[0]!)!;
    const scalar = ctx.scalarOf(ctx.node);
    this.loadNumber(ctx, array.length, scalar, ctx.resultRegister());
  }

  private selectKnownCall(ctx: SelectionContext): void {
    const name = calleeSymbolName(ctx.node)!;
    const symbol = this.target.symbolOf(name);
    const signature = calleeSignature(ctx.node);
    const args = ctx.node.inputs.map((input, index) => {
      const declared = signature?.params[index] ?? null;
      return this.coerce(ctx, input, nativeArgumentScalar(declared));
    });
    ctx.reference(symbol);
    const used = ctx.node.uses.length > 0;
    ctx.emitCall(symbol, args, used ? ctx.resultRegister() : null);
  }

  private bufferAddress(ctx: SelectionContext, buffer: AotStringBuffer): VirtualRegister {
    const datum = ctx.data.intern(
      `string-buffer:${buffer.producer.id}`,
      1,
      () => zeroFilledBuffer(buffer.capacity),
      ".LB",
      true,
    );
    const address = ctx.tempIn(X64_GPR, 8);
    ctx.emit(instruction("leaq", [writeOf(address), mem(8, { symbol: datum.label })]));
    return address;
  }

  private emitBufferCall(
    ctx: SelectionContext,
    symbol: string,
    buffer: AotStringBuffer,
    destination: VirtualRegister,
    operands: readonly VirtualRegister[],
  ): VirtualRegister {
    const capacity = this.loadNumber(ctx, buffer.capacity, SCALAR_INT32);
    const result = ctx.tempIn(X64_GPR, 8);
    ctx.external(symbol);
    ctx.emitCall(symbol, [destination, capacity, ...operands], result);
    return result;
  }

  private selectStringConcat(ctx: SelectionContext): void {
    const buffer = ctx.legality.stringBufferOf(ctx.node)!;
    const left = ctx.registerOf(ctx.node.inputs[0]!);
    const right = ctx.registerOf(ctx.node.inputs[1]!);
    const initialized = this.emitBufferCall(
      ctx,
      X64_RUNTIME_SYMBOLS.stringSet,
      buffer,
      this.bufferAddress(ctx, buffer),
      [left],
    );
    const appended = this.emitBufferCall(
      ctx,
      X64_RUNTIME_SYMBOLS.stringAppend,
      buffer,
      initialized,
      [right],
    );
    this.produce(ctx, appended, SCALAR_STRING);
  }

  private selectStringBuffered(ctx: SelectionContext, symbol: string): void {
    const buffer = ctx.legality.stringBufferOf(ctx.node)!;
    const intrinsic = builtinIntrinsicByName(String(ctx.node.props.name))!;
    const operands = ctx.node.inputs.map((input, index) =>
      this.coerce(ctx, input, nativeArgumentScalar(intrinsic.signature.params[index] ?? null)),
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

  private selectBuiltin(ctx: SelectionContext): void {
    const name = String(ctx.node.props.name);
    const buffered = STRING_BUFFER_BUILTINS.get(name);
    if (buffered !== undefined) {
      this.selectStringBuffered(ctx, buffered);
      return;
    }
    const intrinsic = builtinIntrinsicByName(name)!;
    const args = ctx.node.inputs.map((input, index) => {
      const declared = intrinsic.signature.params[index] ?? null;
      return this.coerce(ctx, input, nativeArgumentScalar(declared));
    });
    const scalar = ctx.scalarOf(ctx.node);

    if (name === qualifiedMethodName("Math", "sqrt")) {
      const result = this.destination(ctx, SCALAR_FLOAT64);
      ctx.emit(instruction("sqrtsd", [writeOf(result), readOf(args[0]!)]));
      this.produce(ctx, result, SCALAR_FLOAT64);
      return;
    }
    if (name === qualifiedMethodName("Math", "abs")) {
      const mask = ctx.data.intern(ABS_MASK_KEY, 16, () => x64MaskDirectives(ABS_MASK_KEY));
      const result = this.destination(ctx, SCALAR_FLOAT64);
      ctx.emit(
        instruction(
          "andpd",
          [writeOf(result), readOf(args[0]!), mem(16, { symbol: mask.label })],
          { tied: true },
        ),
      );
      this.produce(ctx, result, SCALAR_FLOAT64);
      return;
    }
    if (name === qualifiedMethodName("Math", "round")) {
      const half = this.loadNumber(ctx, 0.5, SCALAR_FLOAT64);
      const shifted = ctx.temp(SCALAR_FLOAT64);
      ctx.emit(
        instruction("addsd", [writeOf(shifted), readOf(args[0]!), readOf(half)], {
          tied: true,
        }),
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
      throw new Error(`x64 backend has no lowering for admitted builtin ${name}`);
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
}

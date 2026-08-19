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
  IR_NOT,
  IR_RETURN,
  allocationShapeOf,
  fieldOffsetOf,
  fieldScalarOf,
  textCapacityOf,
  IR_LOAD_TEXT,
  IR_STORE_TEXT,
  IR_STORE_ELEMENT,
} from "../../ir/index.js";
import {
  AOT_CHAR_AT,
  AOT_FLOAT_TO_STRING,
  AOT_INT_TO_STRING,
  calleeSymbolName,
  type AotStringBuffer,
  type PrintableAggregate,
} from "../../analyses/aot-legality.js";
import { isPendingThrowReturn } from "../../builder/throw-recovery.js";
import { asciiData, integerData, zeroFilledBuffer } from "../../machine/data.js";
import { ARRAY_PRINT_SYMBOLS } from "./print-aggregate.js";
import type { FrameLayout, SavedRegister } from "../../machine/frame.js";
import { latticeFromDeclaredType } from "../../types/declared.js";
import type { DeclaredSignature } from "../../types/signature.js";
import {
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_TEXT,
  SCALAR_VOID,
  scalarWidth,
  type AotScalar,
} from "../../types/scalar.js";
import {
  AGGREGATE_SEPARATOR_TEXT,
  builtinIntrinsicByName,
  builtinParameterAt,
  INPUT_BUILTIN,
  NO_TERMINATOR,
  OBJECT_CLOSE_TEXT,
  OBJECT_OPEN_TEXT,
  PARSE_FLOAT_BUILTIN,
  PARSE_INT_BUILTIN,
  PRINT_BUILTIN,
  printTerminatorAt,
  qualifiedMethodName,
  THROW_BUILTIN,
} from "../../metadata/builtin-methods.js";
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
  type MemoryOperand,
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
  x64MaskData,
} from "./runtime.js";
import {
  CLASS_FLAGS_OFFSET,
  CLASS_SHAPE_ID_OFFSET,
} from "../../metadata/class-table.js";
import {
  TERA_COUNT_BYTES,
  TERA_POINTER_BYTES,
} from "../../target/runtime-layout.js";
import {
  INT32_MAX,
  INT32_MIN,
  INT32_SHIFT_MASK,
} from "../../target/integer.js";
import {
  contextField,
  ROOT_COUNT_REGISTER,
  ROOT_ENTRY_BYTES,
  ROOT_FRAME_REGISTER,
  ROOT_SLOT_SHIFT,
} from "./heap.js";
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

const ROUND_TOWARD_NEGATIVE = 9;
const ROUND_TOWARD_POSITIVE = 10;
const ROUND_TOWARD_ZERO = 11;

const ROUNDING_MODES = new Map<string, number>([
  [qualifiedMethodName("Math", "floor"), ROUND_TOWARD_NEGATIVE],
  [qualifiedMethodName("Math", "ceil"), ROUND_TOWARD_POSITIVE],
  [qualifiedMethodName("Math", "trunc"), ROUND_TOWARD_ZERO],
]);

const RUNTIME_BUILTINS = new Map<string, string>([
  [qualifiedMethodName("Math", "min"), X64_RUNTIME_SYMBOLS.minimum],
  [qualifiedMethodName("Math", "max"), X64_RUNTIME_SYMBOLS.maximum],
  [qualifiedMethodName("string", "char_code_at"), X64_RUNTIME_SYMBOLS.charCodeAt],
  [qualifiedMethodName("string", "index_of"), X64_RUNTIME_SYMBOLS.stringIndexOf],
  [qualifiedMethodName("string", "includes"), X64_RUNTIME_SYMBOLS.stringIncludes],
  [qualifiedMethodName("string", "starts_with"), X64_RUNTIME_SYMBOLS.stringStartsWith],
  [qualifiedMethodName("string", "ends_with"), X64_RUNTIME_SYMBOLS.stringEndsWith],
  [PARSE_INT_BUILTIN, X64_RUNTIME_SYMBOLS.parseInt],
  [PARSE_FLOAT_BUILTIN, X64_RUNTIME_SYMBOLS.parseFloat],
]);

const STRING_BUFFER_BUILTINS = new Map<string, string>([
  [AOT_CHAR_AT, X64_RUNTIME_SYMBOLS.charAt],
  [AOT_INT_TO_STRING, X64_RUNTIME_SYMBOLS.int32ToString],
  [AOT_FLOAT_TO_STRING, X64_RUNTIME_SYMBOLS.floatToString],
  [INPUT_BUILTIN, X64_RUNTIME_SYMBOLS.input],
  [qualifiedMethodName("string", "to_upper_case"), X64_RUNTIME_SYMBOLS.stringUpper],
  [qualifiedMethodName("string", "to_lower_case"), X64_RUNTIME_SYMBOLS.stringLower],
  [qualifiedMethodName("string", "trim"), X64_RUNTIME_SYMBOLS.stringTrim],
  [qualifiedMethodName("string", "trim_start"), X64_RUNTIME_SYMBOLS.stringTrimStart],
  [qualifiedMethodName("string", "trim_end"), X64_RUNTIME_SYMBOLS.stringTrimEnd],
  [qualifiedMethodName("string", "slice"), X64_RUNTIME_SYMBOLS.stringSlice],
  [qualifiedMethodName("string", "repeat"), X64_RUNTIME_SYMBOLS.stringRepeat],
  [qualifiedMethodName("string", "replace"), X64_RUNTIME_SYMBOLS.stringReplace],
  [qualifiedMethodName("string", "replace_all"), X64_RUNTIME_SYMBOLS.stringReplaceAll],
]);

const PRINT_ROUTINES = new Map<AotScalar, string>([
  [SCALAR_STRING, X64_RUNTIME_SYMBOLS.printString],
  [SCALAR_INT32, X64_RUNTIME_SYMBOLS.printInt],
  [SCALAR_FLOAT64, X64_RUNTIME_SYMBOLS.printFloat],
]);

const SHIFT_MASK = INT32_SHIFT_MASK;

function doubleBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

function calleeSignature(node: CFGInstruction): DeclaredSignature | null {
  const target = node.props.target as { declaredSignature?: DeclaredSignature } | undefined;
  return target?.declaredSignature ?? null;
}

const POINTER_WIDTH = TERA_POINTER_BYTES;
const SHAPE_ID_WIDTH = TERA_COUNT_BYTES;

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
        [asciiData(text)],
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

  storeRoot(
    frame: StackSlot,
    index: number,
    value: RegisterOperand,
    address: VirtualRegister,
  ): readonly MachineInstruction[] {
    return [
      instruction("movq", [
        writeOf(address),
        mem(8, { base: this.stackPointer(), slot: frame }),
      ]),
      instruction("movq", [
        mem(value.width, { base: readOf(address), displacement: index * ROOT_ENTRY_BYTES }),
        value,
      ]),
    ];
  }

  private enterRoots(frame: FrameLayout): readonly MachineInstruction[] {
    if (frame.rootFrame === null) return [];
    return [
      instruction("movl", [
        def(this.physical(ROOT_COUNT_REGISTER), 4),
        imm(frame.roots),
      ]),
      instruction("call", [sym(X64_RUNTIME_SYMBOLS.enterRoots)], {
        call: true,
        implicitFrom: 1,
      }),
      instruction("movq", [
        mem(8, { base: this.stackPointer(), slot: frame.rootFrame }),
        use(this.physical(ROOT_FRAME_REGISTER), 8),
      ]),
    ];
  }

  private leaveRoots(frame: FrameLayout): readonly MachineInstruction[] {
    if (frame.rootFrame === null) return [];
    const cursor = this.physical(ROOT_FRAME_REGISTER);
    const table = this.physical(ROOT_COUNT_REGISTER);
    return [
      instruction("movq", [
        def(cursor, 8),
        mem(8, { base: this.stackPointer(), slot: frame.rootFrame }),
      ]),
      instruction("movq", [def(table, 8), contextField("rootsBase")]),
      instruction("subq", [def(cursor, 8), use(table, 8)]),
      instruction("shrq", [def(cursor, 8), imm(ROOT_SLOT_SHIFT)]),
      instruction("movq", [contextField("rootCount"), use(cursor, 8)]),
    ];
  }

  private physical(name: string): PhysicalRegister {
    return this.target.registers.register(name);
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

  private adjustStack(delta: number): MachineInstruction[] {
    if (delta === 0) return [];
    const pointer = this.target.abi.stackPointer;
    return [
      instruction(
        delta < 0 ? "subq" : "addq",
        [def(pointer, 8), use(pointer, 8), imm(Math.abs(delta))],
        { tied: true },
      ),
    ];
  }

  private frameSlotAccess(saved: SavedRegister, store: boolean): MachineInstruction {
    const width = this.target.registers.classOf(saved.register.classId).saveBytes;
    const mnemonic = saved.register.classId === X64_FPR ? "movups" : "movq";
    const location = mem(width, {
      base: this.stackPointer(),
      displacement: saved.offset,
    });
    return store
      ? instruction(mnemonic, [location, use(saved.register, width)])
      : instruction(mnemonic, [def(saved.register, width), location]);
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
    if (scalar === SCALAR_POINTER) {
      ctx.emit(instruction("movabsq", [writeOf(into), imm(value)]));
      return into;
    }
    const bits = doubleBits(value);
    const datum = ctx.data.intern(`double:${bits}`, 8, [integerData(bits, 8)]);
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
    const mask = ctx.data.intern(SIGN_MASK_KEY, 16, x64MaskData(SIGN_MASK_KEY));
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
    if (float && ctx.node.inputs.every((input) => ctx.scalarOf(input) === SCALAR_POINTER)) {
      this.selectReferenceCompare(ctx);
      return;
    }
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

  private selectStringCompare(ctx: SelectionContext): void {
    if (ctx.node.inputs.every((input) => ctx.scalarOf(input) === SCALAR_POINTER)) {
      this.selectReferenceCompare(ctx);
      return;
    }
    const left = ctx.registerOf(ctx.node.inputs[0]!);
    const right = ctx.registerOf(ctx.node.inputs[1]!);
    const ordering = ctx.temp(SCALAR_INT32);
    ctx.external(X64_RUNTIME_SYMBOLS.stringCompare);
    ctx.emitCall(X64_RUNTIME_SYMBOLS.stringCompare, [left, right], ordering);
    const zero = this.loadNumber(ctx, 0, SCALAR_INT32);
    const result = this.destination(ctx, SCALAR_INT32);
    const code = this.emitIntComparison(ctx, String(ctx.node.props.op), ordering, zero);
    this.emitSetCondition(ctx, code, result);
    this.produce(ctx, result, SCALAR_INT32);
  }

  private selectReferenceCompare(ctx: SelectionContext): void {
    const operation = String(ctx.node.props.op);
    const code = INT_CONDITIONS.get(operation);
    if (code === undefined) {
      throw new BackendLoweringError(`unsupported comparison ${operation}`);
    }
    const left = ctx.registerOf(ctx.node.inputs[0]!);
    const right = ctx.registerOf(ctx.node.inputs[1]!);
    ctx.emit(instruction("cmpq", [use(left, 8), use(right, 8)]));
    const result = this.destination(ctx, SCALAR_INT32);
    this.emitSetCondition(ctx, code, result);
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

  private fieldAddress(receiver: VirtualRegister, width: number, offset: number) {
    return mem(width, { base: use(receiver, 8), displacement: offset });
  }

  private selectNewObject(ctx: SelectionContext): void {
    const shape = allocationShapeOf(ctx.node);
    const size = this.loadNumber(ctx, shape.size, SCALAR_INT32);
    const identity = this.loadNumber(ctx, shape.id, SCALAR_INT32);
    ctx.external(X64_RUNTIME_SYMBOLS.allocate);

    const object = ctx.resultRegister();
    const cursor = ctx.tempIn(ctx.classOf(SCALAR_POINTER), POINTER_WIDTH);
    const next = ctx.tempIn(ctx.classOf(SCALAR_POINTER), POINTER_WIDTH);
    const fork = ctx.guard("alloc");

    ctx.emit(instruction("movq", [writeOf(cursor), contextField("arenaCursor")]));
    ctx.emit(
      instruction("leaq", [
        writeOf(next),
        mem(POINTER_WIDTH, { base: readOf(cursor), displacement: shape.size }),
      ]),
    );
    ctx.emit(instruction("cmpq", [readOf(next), contextField("arenaCommitted")]));
    ctx.emit(instruction("ja", [label(fork.taken)]));
    ctx.emit(instruction("movq", [contextField("arenaCursor"), readOf(next)]));
    ctx.emit(instruction("movq", [writeOf(object), contextField("arenaBase")]));
    ctx.emit(instruction("addq", [writeOf(object), readOf(cursor)]));
    ctx.emit(
      instruction("movl", [
        mem(SHAPE_ID_WIDTH, { base: readOf(object), displacement: CLASS_SHAPE_ID_OFFSET }),
        imm(shape.id),
      ]),
    );
    ctx.emit(
      instruction("movl", [
        mem(SHAPE_ID_WIDTH, { base: readOf(object), displacement: CLASS_FLAGS_OFFSET }),
        imm(shape.size),
      ]),
    );
    ctx.emit(this.jump(fork.rejoin));

    fork.enterTaken();
    ctx.emitCall(X64_RUNTIME_SYMBOLS.allocate, [size, identity], object);
    ctx.emit(this.jump(fork.rejoin));

    fork.enterRejoin();
  }

  private selectArrayReserve(ctx: SelectionContext): void {
    const growth = arrayReserveOf(ctx.node);
    const array = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_POINTER);
    const buffer = this.loadNumber(ctx, growth.buffer, SCALAR_INT32);
    const stride = this.loadNumber(ctx, growth.elementBytes, SCALAR_INT32);
    ctx.external(X64_RUNTIME_SYMBOLS.arrayReserve);
    ctx.emitCall(
      X64_RUNTIME_SYMBOLS.arrayReserve,
      [array, buffer, stride],
      ctx.resultRegister(),
    );
  }

  private selectRuntimeBase(ctx: SelectionContext): void {
    const base = ctx.resultRegister();
    ctx.emit(
      instruction("leaq", [
        writeOf(base),
        mem(8, { symbol: String(ctx.node.props.symbol) }),
      ]),
    );
  }

  private selectLoadField(ctx: SelectionContext): void {
    const scalar = fieldScalarOf(ctx.node);
    const width = ctx.widthOf(scalar);
    const receiver = ctx.registerOf(ctx.node.inputs[0]!);
    const loaded = this.destination(ctx, scalar);
    ctx.emit(
      instruction(this.moveFor(writeOf(loaded)), [
        def(loaded, width),
        this.fieldAddress(receiver, width, fieldOffsetOf(ctx.node)),
      ]),
    );
    this.produce(ctx, loaded, scalar);
  }

  private selectStoreField(ctx: SelectionContext): void {
    const scalar = fieldScalarOf(ctx.node);
    const width = ctx.widthOf(scalar);
    const receiver = ctx.registerOf(ctx.node.inputs[0]!);
    const value = this.coerce(ctx, ctx.node.inputs[1]!, scalar);
    ctx.emit(
      instruction(this.moveFor(readOf(value)), [
        this.fieldAddress(receiver, width, fieldOffsetOf(ctx.node)),
        use(value, width),
      ]),
    );
    if (ctx.node.uses.length > 0) this.produce(ctx, value, scalar);
  }

  private textAddress(ctx: SelectionContext, destination: VirtualRegister): VirtualRegister {
    const receiver = ctx.registerOf(ctx.node.inputs[0]!);
    ctx.emit(
      instruction("leaq", [
        writeOf(destination),
        this.fieldAddress(receiver, POINTER_WIDTH, fieldOffsetOf(ctx.node)),
      ]),
    );
    return destination;
  }

  private selectLoadText(ctx: SelectionContext): void {
    const address = this.textAddress(ctx, this.destination(ctx, SCALAR_STRING));
    this.produce(ctx, address, SCALAR_STRING);
  }

  private selectStoreText(ctx: SelectionContext): void {
    const value = this.coerce(ctx, ctx.node.inputs[1]!, SCALAR_STRING);
    const destination = this.textAddress(ctx, ctx.tempIn(X64_GPR, POINTER_WIDTH));
    const capacity = this.loadNumber(ctx, textCapacityOf(ctx.node), SCALAR_INT32);
    ctx.external(X64_RUNTIME_SYMBOLS.stringSet);
    ctx.emitCall(X64_RUNTIME_SYMBOLS.stringSet, [destination, capacity, value], null);
  }

  private elementPlace(ctx: SelectionContext): { element: AotScalar; address: MemoryOperand } {
    const element = heapElementScalarOf(ctx.node)!;
    const width = ctx.widthOf(element);
    const receiver = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_POINTER);
    const index = this.index(ctx, ctx.node.inputs[1]!);
    return {
      element,
      address: mem(width, {
        base: use(receiver, POINTER_WIDTH),
        index: index === null ? null : use(index, POINTER_WIDTH),
        scale: width,
        displacement: fieldOffsetOf(ctx.node),
      }),
    };
  }

  private selectLoadElement(ctx: SelectionContext): void {
    const { element, address } = this.elementPlace(ctx);
    const loaded = this.destination(ctx, element);
    ctx.emit(
      instruction(this.moveFor(writeOf(loaded)), [def(loaded, ctx.widthOf(element)), address]),
    );
    this.produce(ctx, loaded, element);
  }

  private selectStoreElement(ctx: SelectionContext): void {
    const { element, address } = this.elementPlace(ctx);
    const value = this.coerce(ctx, ctx.node.inputs[2]!, element);
    ctx.emit(
      instruction(this.moveFor(readOf(value)), [address, use(value, ctx.widthOf(element))]),
    );
    if (ctx.node.uses.length > 0) this.produce(ctx, value, element);
  }

  private selectKnownCall(ctx: SelectionContext): void {
    const name = calleeSymbolName(ctx.node)!;
    const symbol = this.target.symbolOf(name);
    const signature = calleeSignature(ctx.node);
    const args = ctx.node.inputs.map((input, index) => {
      const declared = signature?.params[index] ?? null;
      return this.coerce(ctx, input, nativeArgumentScalar(declared, ctx.classes));
    });
    ctx.reference(symbol);
    const used = ctx.node.uses.length > 0;
    ctx.emitCall(symbol, args, used ? ctx.resultRegister() : null);
  }

  private bufferAddress(ctx: SelectionContext, buffer: AotStringBuffer): VirtualRegister {
    const datum = ctx.data.intern(
      `string-buffer:${buffer.producer.id}`,
      1,
      zeroFilledBuffer(buffer.capacity),
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
      this.coerce(ctx, input, nativeArgumentScalar(builtinParameterAt(intrinsic, index), ctx.classes)),
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

  private emitPrintText(ctx: SelectionContext, text: string, terminator: number): void {
    const datum = ctx.data.intern(`aggregate:${text}`, 1, [asciiData(text)], ".LS");
    const address = ctx.tempIn(X64_GPR, 8);
    ctx.emit(instruction("leaq", [writeOf(address), mem(8, { symbol: datum.label })]));
    ctx.external(X64_RUNTIME_SYMBOLS.printString);
    ctx.emitCall(
      X64_RUNTIME_SYMBOLS.printString,
      [address, this.loadNumber(ctx, terminator, SCALAR_INT32)],
      null,
    );
  }

  private selectPrintValue(
    ctx: SelectionContext,
    operand: VirtualRegister,
    scalar: AotScalar,
    terminator: number,
  ): void {
    const symbol = PRINT_ROUTINES.get(scalar);
    if (symbol === undefined) {
      throw new BackendLoweringError(`x64 backend cannot print a ${scalar} value`);
    }
    ctx.external(symbol);
    ctx.emitCall(symbol, [operand, this.loadNumber(ctx, terminator, SCALAR_INT32)], null);
  }

  private selectPrintAggregate(
    ctx: SelectionContext,
    value: CFGInstruction,
    aggregate: PrintableAggregate,
    terminator: number,
  ): void {
    const receiver = this.coerce(ctx, value, SCALAR_POINTER);
    if (aggregate.kind === "array") {
      const symbol = ARRAY_PRINT_SYMBOLS.get(aggregate.element);
      if (symbol === undefined) {
        throw new BackendLoweringError(
          `x64 backend cannot print an array of ${aggregate.element}`,
        );
      }
      ctx.external(symbol);
      ctx.emitCall(
        symbol,
        [receiver, this.loadNumber(ctx, terminator, SCALAR_INT32)],
        null,
      );
      return;
    }
    this.emitPrintText(ctx, OBJECT_OPEN_TEXT, NO_TERMINATOR);
    aggregate.fields.forEach((field, index) => {
      if (index > 0) this.emitPrintText(ctx, AGGREGATE_SEPARATOR_TEXT, NO_TERMINATOR);
      this.emitPrintText(ctx, `${field.name}: `, NO_TERMINATOR);
      const inline = field.scalar === SCALAR_TEXT;
      const scalar = inline ? SCALAR_STRING : field.scalar;
      const slot = ctx.tempIn(X64_GPR, 8);
      if (inline) {
        ctx.emit(
          instruction("leaq", [
            writeOf(slot),
            mem(8, { base: readOf(receiver), displacement: field.offset }),
          ]),
        );
        this.selectPrintValue(ctx, slot, scalar, NO_TERMINATOR);
        return;
      }
      const loaded = ctx.temp(scalar);
      ctx.emit(
        instruction(this.moveFor(writeOf(loaded)), [
          writeOf(loaded),
          mem(scalarWidth(scalar), {
            base: readOf(receiver),
            displacement: field.offset,
          }),
        ]),
      );
      this.selectPrintValue(ctx, loaded, scalar, NO_TERMINATOR);
    });
    this.emitPrintText(ctx, OBJECT_CLOSE_TEXT, terminator);
  }

  private selectPrint(ctx: SelectionContext): void {
    const arity = ctx.node.inputs.length;
    ctx.node.inputs.forEach((value, index) => {
      const terminator = printTerminatorAt(index, arity);
      const scalar = ctx.scalarOf(value);
      const aggregate =
        scalar === SCALAR_POINTER ? ctx.legality.aggregateOf(value) : null;
      if (aggregate !== null) {
        this.selectPrintAggregate(ctx, value, aggregate, terminator);
        return;
      }
      this.selectPrintValue(ctx, this.coerce(ctx, value, scalar), scalar, terminator);
    });
  }

  private selectThrow(ctx: SelectionContext): void {
    const message = this.coerce(ctx, ctx.node.inputs[0]!, SCALAR_STRING);
    ctx.external(X64_RUNTIME_SYMBOLS.throwError);
    ctx.emitCall(X64_RUNTIME_SYMBOLS.throwError, [message], null);
  }

  private selectBuiltin(ctx: SelectionContext): void {
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
    const args = ctx.node.inputs.map((input, index) => {
      const declared = builtinParameterAt(intrinsic, index);
      return this.coerce(ctx, input, nativeArgumentScalar(declared, ctx.classes));
    });
    const scalar = ctx.scalarOf(ctx.node);

    if (name === qualifiedMethodName("Math", "sqrt")) {
      const result = this.destination(ctx, SCALAR_FLOAT64);
      ctx.emit(instruction("sqrtsd", [writeOf(result), readOf(args[0]!)]));
      this.produce(ctx, result, SCALAR_FLOAT64);
      return;
    }
    if (name === qualifiedMethodName("Math", "abs")) {
      const mask = ctx.data.intern(ABS_MASK_KEY, 16, x64MaskData(ABS_MASK_KEY));
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
      this.emitRounding(ctx, shifted, ROUND_TOWARD_NEGATIVE);
      return;
    }
    if (name === qualifiedMethodName("string", "length")) {
      this.emitIntHelperCall(ctx, X64_RUNTIME_SYMBOLS.stringLength, args);
      return;
    }
    const rounding = ROUNDING_MODES.get(name);
    if (rounding !== undefined) {
      this.emitRounding(ctx, args[0]!, rounding);
      return;
    }
    const runtime = RUNTIME_BUILTINS.get(name);
    if (runtime === undefined) {
      throw new BackendLoweringError(
        `x64 backend has no lowering for admitted builtin ${name}`,
      );
    }
    this.emitLibraryCall(ctx, runtime, args, scalar);
  }

  private emitRounding(
    ctx: SelectionContext,
    source: VirtualRegister,
    mode: number,
  ): void {
    const result = this.destination(ctx, SCALAR_FLOAT64);
    ctx.emit(instruction("roundsd", [writeOf(result), readOf(source), imm(mode)]));
    this.produce(ctx, result, SCALAR_FLOAT64);
  }

  private emitIntHelperCall(
    ctx: SelectionContext,
    symbol: string,
    args: readonly VirtualRegister[],
  ): void {
    const result = this.destination(ctx, SCALAR_INT32);
    ctx.external(symbol);
    ctx.emitCall(symbol, args, result);
    this.produce(ctx, result, SCALAR_INT32);
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

import type { Dependency } from "../../../deopt/dependencies.js";
import type { FeedbackVector } from "../../../feedback/vector/index.js";
import type { TaggedValue } from "../../../core/value/index.js";

export const ROP_LDA_CONST = 0x01;
export const ROP_LDA_REG = 0x02;
export const ROP_STAR = 0x03;
export const ROP_MOV = 0x04;

export const ROP_LDA_GLOBAL = 0x05;
export const ROP_STA_GLOBAL = 0x06;

export const ROP_LDA_PROP = 0x07;
export const ROP_STA_PROP = 0x08;
export const ROP_LDA_INDEX = 0x09;
export const ROP_STA_INDEX = 0x0a;

export const ROP_ADD = 0x10;
export const ROP_SUB = 0x11;
export const ROP_MUL = 0x12;
export const ROP_DIV = 0x13;
export const ROP_MOD = 0x14;

export const ROP_EQ = 0x15;
export const ROP_NEQ = 0x16;
export const ROP_LT = 0x17;
export const ROP_GT = 0x18;
export const ROP_LTE = 0x19;
export const ROP_GTE = 0x1a;

export const ROP_NOT = 0x1b;
export const ROP_NEG = 0x1c;
export const ROP_TYPEOF = 0x1d;

export const ROP_JUMP = 0x20;
export const ROP_JUMP_IF_FALSE = 0x21;
export const ROP_JUMP_IF_TRUE = 0x22;

export const ROP_CALL = 0x30;
export const ROP_CALL_METHOD = 0x31;
export const ROP_NEW = 0x32;

export const ROP_NEW_OBJECT = 0x33;
export const ROP_NEW_ARRAY = 0x34;

export const ROP_RETURN = 0x40;
export const ROP_LDA_UNDEFINED = 0x41;
export const ROP_LDA_NULL = 0x42;
export const ROP_LDA_TRUE = 0x43;
export const ROP_LDA_FALSE = 0x44;
export const ROP_LDA_THIS = 0x45;

export const ROP_LDA_UPVALUE = 0x46;
export const ROP_STA_UPVALUE = 0x47;
export const ROP_MAKE_CLOSURE = 0x48;

export const ROP_TRY_START = 0x50;
export const ROP_TRY_END = 0x51;
export const ROP_THROW = 0x52;

export const ROP_GET_KEYS = 0x53;
export const ROP_GET_LENGTH = 0x54;

export const ROP_TEST_FEEDBACK = 0x55;

export const ROP_AWAIT = 0x60;
export const ROP_GET_ITERATOR = 0x61;
export const ROP_ITER_NEXT = 0x62;
export const ROP_ITER_DONE = 0x63;
export const ROP_ITER_VALUE = 0x64;
export const ROP_YIELD = 0x65;
export const ROP_NEW_REGEX = 0x66;

export const ROP_BITAND = 0x70;
export const ROP_BITOR = 0x71;
export const ROP_BITXOR = 0x72;
export const ROP_SHL = 0x73;
export const ROP_SHR = 0x74;
export const ROP_USHR = 0x75;
export const ROP_POW = 0x76;
export const ROP_BITNOT = 0x77;
export const ROP_INSTANCEOF = 0x78;
export const ROP_IN = 0x79;
export const ROP_VOID = 0x7a;
export const ROP_DELETE_PROP = 0x7b;
export const ROP_IS_NULLISH = 0x7c;
export const ROP_REST_ARGS = 0x7d;
export const ROP_SPREAD_ARRAY = 0x7e;
export const ROP_COPY_PROPS = 0x7f;
export const ROP_STA_COMPUTED_PROP = 0x80;
export const ROP_CALL_SPREAD = 0x81;
export const ROP_ARRAY_PUSH = 0x82;
export const ROP_LOOSE_EQ = 0x83;
export const ROP_LOOSE_NEQ = 0x84;
export const ROP_SET_PROTO = 0x85;
export const ROP_DEFINE_ACCESSOR = 0x86;
export const ROP_CLOSE_UPVALUES = 0x87;
export const ROP_LOAD_ARGUMENTS = 0x88;
export const ROP_ARRAY_REST = 0x89;
export const ROP_OBJECT_REST = 0x8a;
export const ROP_CALL_NAMED = 0x8b;
export const ROP_CALL_METHOD_NAMED = 0x8c;
export const ROP_MATMUL = 0x8d;
export const ROP_CALL_SPREAD_NAMED = 0x8e;
export const ROP_CALL_METHOD_SPREAD_NAMED = 0x8f;

export const ROP_LDA_KEYED_SLICE = 0x90;

export type RegisterOpcode = number;
export type RegisterOperand = number;
export type RegisterConstant = RuntimeValue | RegisterCompiledFunction | string[];
export type BaselineCode = {
  (args: TaggedValue[], thisValue: TaggedValue, interpreter: object): TaggedValue;
  _call0?: (thisValue: TaggedValue, interpreter: object) => TaggedValue;
  _call1?: (
    a0: TaggedValue,
    thisValue: TaggedValue,
    interpreter: object,
  ) => TaggedValue;
  _call2?: (
    a0: TaggedValue,
    a1: TaggedValue,
    thisValue: TaggedValue,
    interpreter: object,
  ) => TaggedValue;
  _call3?: (
    a0: TaggedValue,
    a1: TaggedValue,
    a2: TaggedValue,
    thisValue: TaggedValue,
    interpreter: object,
  ) => TaggedValue;
  _isBaseline?: boolean;
};
export type OptimizedCode = {
  (args: TaggedValue[], thisValue: TaggedValue, interpreter: object): TaggedValue;
  _dispose?: () => void;
  _osrEntry?: (
    locals: Array<TaggedValue | object>,
    loopHeaderOffset: number,
    thisValue: TaggedValue,
    acc: TaggedValue,
  ) => TaggedValue;
};
export type LocalBindingKind = "temp" | "var" | "let" | "const" | "class";

export type SourceMapEntry = {
  pc?: number;
  line?: number;
  column?: number;
  [key: string]: RuntimeValue;
};

export type UpvalueDescriptor = {
  name?: string;
  index?: number;
  isLocal?: boolean;
  outerType?: "local" | "upvalue";
  outerSlot?: number;
};

export type SimpleConstructorSource =
  | { kind: "local"; index: number }
  | { kind: "const"; index: number }
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "true" }
  | { kind: "false" };

export type SimpleConstructorField = {
  name: string;
  source: SimpleConstructorSource;
};

const ROPCODE_NAMES: Record<number, string> = {
  [ROP_LOAD_ARGUMENTS]: "LoadArguments",
  [ROP_ARRAY_REST]: "ArrayRest",
  [ROP_OBJECT_REST]: "ObjectRest",
  [ROP_LDA_CONST]: "LdaConst",
  [ROP_LDA_REG]: "Ldar",
  [ROP_STAR]: "Star",
  [ROP_MOV]: "Mov",
  [ROP_LDA_GLOBAL]: "LdaGlobal",
  [ROP_STA_GLOBAL]: "StaGlobal",
  [ROP_LDA_PROP]: "LdaNamedProperty",
  [ROP_STA_PROP]: "StaNamedProperty",
  [ROP_LDA_INDEX]: "LdaKeyedProperty",
  [ROP_STA_INDEX]: "StaKeyedProperty",
  [ROP_ADD]: "Add",
  [ROP_SUB]: "Sub",
  [ROP_MUL]: "Mul",
  [ROP_DIV]: "Div",
  [ROP_MOD]: "Mod",
  [ROP_EQ]: "TestEqual",
  [ROP_NEQ]: "TestNotEqual",
  [ROP_LT]: "TestLessThan",
  [ROP_GT]: "TestGreaterThan",
  [ROP_LTE]: "TestLessThanOrEqual",
  [ROP_GTE]: "TestGreaterThanOrEqual",
  [ROP_NOT]: "LogicalNot",
  [ROP_NEG]: "Negate",
  [ROP_TYPEOF]: "TypeOf",
  [ROP_JUMP]: "Jump",
  [ROP_JUMP_IF_FALSE]: "JumpIfFalse",
  [ROP_JUMP_IF_TRUE]: "JumpIfTrue",
  [ROP_CALL]: "Call",
  [ROP_CALL_METHOD]: "CallMethod",
  [ROP_NEW]: "Construct",
  [ROP_NEW_OBJECT]: "CreateObject",
  [ROP_NEW_ARRAY]: "CreateArray",
  [ROP_RETURN]: "Return",
  [ROP_LDA_UNDEFINED]: "LdaUndefined",
  [ROP_LDA_NULL]: "LdaNull",
  [ROP_LDA_TRUE]: "LdaTrue",
  [ROP_LDA_FALSE]: "LdaFalse",
  [ROP_LDA_THIS]: "LdaThis",
  [ROP_LDA_UPVALUE]: "LdaUpvalue",
  [ROP_STA_UPVALUE]: "StaUpvalue",
  [ROP_MAKE_CLOSURE]: "MakeClosure",
  [ROP_TRY_START]: "TryStart",
  [ROP_TRY_END]: "TryEnd",
  [ROP_THROW]: "Throw",
  [ROP_GET_KEYS]: "GetKeys",
  [ROP_GET_LENGTH]: "GetLength",
  [ROP_TEST_FEEDBACK]: "TestFeedback",
  [ROP_AWAIT]: "Await",
  [ROP_GET_ITERATOR]: "GetIterator",
  [ROP_ITER_NEXT]: "IterNext",
  [ROP_ITER_DONE]: "IterDone",
  [ROP_ITER_VALUE]: "IterValue",
  [ROP_YIELD]: "Yield",
  [ROP_NEW_REGEX]: "NewRegex",
  [ROP_BITAND]: "BitwiseAnd",
  [ROP_BITOR]: "BitwiseOr",
  [ROP_BITXOR]: "BitwiseXor",
  [ROP_SHL]: "ShiftLeft",
  [ROP_SHR]: "ShiftRight",
  [ROP_USHR]: "ShiftRightLogical",
  [ROP_POW]: "Exp",
  [ROP_BITNOT]: "BitwiseNot",
  [ROP_INSTANCEOF]: "TestInstanceOf",
  [ROP_IN]: "TestIn",
  [ROP_VOID]: "Void",
  [ROP_DELETE_PROP]: "DeleteProperty",
  [ROP_IS_NULLISH]: "IsNullish",
  [ROP_REST_ARGS]: "RestArgs",
  [ROP_SPREAD_ARRAY]: "SpreadArray",
  [ROP_COPY_PROPS]: "CopyProperties",
  [ROP_STA_COMPUTED_PROP]: "StaComputedProperty",
  [ROP_CALL_SPREAD]: "CallWithSpread",
  [ROP_ARRAY_PUSH]: "ArrayPush",
  [ROP_LOOSE_EQ]: "TestLooseEqual",
  [ROP_LOOSE_NEQ]: "TestLooseNotEqual",
  [ROP_SET_PROTO]: "SetPrototype",
  [ROP_DEFINE_ACCESSOR]: "DefineAccessor",
  [ROP_CLOSE_UPVALUES]: "CloseUpvalues",
  [ROP_CALL_NAMED]: "CallNamed",
  [ROP_CALL_METHOD_NAMED]: "CallMethodNamed",
  [ROP_MATMUL]: "MatMul",
  [ROP_CALL_SPREAD_NAMED]: "CallSpreadNamed",
  [ROP_CALL_METHOD_SPREAD_NAMED]: "CallMethodSpreadNamed",
  [ROP_LDA_KEYED_SLICE]: "LdaKeyedSlice",
};

export function rOpcodeName(opcode: RegisterOpcode): string {
  return (
    ROPCODE_NAMES[opcode] ??
    `UNKNOWN(0x${opcode.toString(16).padStart(2, "0")})`
  );
}

export class RegisterInstruction {
  opcode: RegisterOpcode;
  operands: RegisterOperand[];

  constructor(opcode: RegisterOpcode, ...operands: RegisterOperand[]) {
    this.opcode = opcode;
    this.operands = operands;
  }

  toString(): string {
    const name = rOpcodeName(this.opcode);
    if (this.operands.length === 0) return name;
    return `${name} ${this.operands.map((o) => (typeof o === "number" ? `r${o}` : String(o))).join(", ")}`;
  }
}

export class RegisterCompiledFunction {
  static nextId = 1;
  id: number;
  name: string | null;
  paramCount: number;
  instructions: RegisterInstruction[];
  constants: RegisterConstant[];
  _constantIndex: Map<RegisterConstant, number>;
  localNames: Array<string | undefined>;
  localBindingKinds: Array<LocalBindingKind | undefined>;
  uninitializedLocalSlots: Set<number>;
  localCount: number;
  registerCount: number;
  feedbackSlotCount: number;
  feedbackVector: FeedbackVector | null;
  invocationCount: number;
  baselineCode: BaselineCode | null;
  optimizedCode: OptimizedCode | null;
  deoptCount: number;
  dependencyDeoptCount: number;
  compileFailureCount: number;
  optimizationCooldownUntil: number;
  lastCompileFailureReason: string | null;
  version: number;
  disableOptimization: boolean;
  optimizedDependencies: Dependency[];
  sourceMap: SourceMapEntry[];
  upvalues: UpvalueDescriptor[];
  isAsync: boolean;
  isGenerator: boolean;
  isClassConstructor: boolean;
  isStrict: boolean;
  callMode?: number;
  selfBindingSlot?: number;
  isLazy: boolean;
  lazySource: string | null;
  lazyBodyStart: number | null;
  lazyBodyEnd: number | null;
  lazyParams: RuntimeValue[] | null;
  lastExecutionTime: number;
  codeAge: number;
  _icKeys: string[] | null;
  hoistedVarNames: string[] | null;
  paramNames: string[] | null;
  constructorStub?: ((args: TaggedValue[]) => TaggedValue) | null;
  simpleConstructorInfo?: SimpleConstructorField[] | null;

  constructor(name: string | null = null, paramCount = 0) {
    this.id = RegisterCompiledFunction.nextId++;
    this.name = name;
    this.paramCount = paramCount;
    this.instructions = [];
    this.constants = [];
    this._constantIndex = new Map();
    this.localNames = [];
    this.localBindingKinds = [];
    this.uninitializedLocalSlots = new Set();
    this.localCount = 0;
    this.registerCount = 0;
    this.feedbackSlotCount = 0;
    this.feedbackVector = null;
    this.invocationCount = 0;
    this.baselineCode = null;
    this.optimizedCode = null;
    this.deoptCount = 0;
    this.dependencyDeoptCount = 0;
    this.compileFailureCount = 0;
    this.optimizationCooldownUntil = 0;
    this.lastCompileFailureReason = null;
    this.version = 0;
    this.disableOptimization = false;
    this.optimizedDependencies = [];
    this.sourceMap = [];
    this.upvalues = [];
    this.isAsync = false;
    this.isGenerator = false;
    this.isClassConstructor = false;
    this.isStrict = false;
    this.isLazy = false;
    this.lazySource = null;
    this.lazyBodyStart = 0;
    this.lazyBodyEnd = 0;
    this.lazyParams = null;
    this.lastExecutionTime = 0;
    this.codeAge = 0;
    this._icKeys = null;
    this.hoistedVarNames = null;
    this.paramNames = null;
  }

  getICKey(funcName: string | null | undefined, fbSlotIdx: number): string {
    if (!this._icKeys) {
      this._icKeys = new Array(this.feedbackSlotCount);
      for (let i = 0; i < this.feedbackSlotCount; i++) {
        this._icKeys[i] = (funcName || "<anonymous>") + "#" + this.id + ":" + i;
      }
    }
    return this._icKeys[fbSlotIdx]!;
  }

  addConstant(value: RegisterConstant): number {
    if (typeof value !== "object" || value === null) {
      const existing = this._constantIndex.get(value);
      if (existing !== undefined) return existing;
    }
    const idx = this.constants.length;
    this.constants.push(value);
    if (typeof value !== "object" || value === null) {
      this._constantIndex.set(value, idx);
    }
    return idx;
  }

  addLocal(name: string): number {
    const slot = this.registerCount++;
    this.localNames[slot] = name;
    this.localBindingKinds[slot] = "temp";
    if (this.localCount <= slot) {
      this.localCount = slot + 1;
    }
    return slot;
  }

  setLocalBindingKind(slot: number, kind: LocalBindingKind): void {
    this.localBindingKinds[slot] = kind;
    if (kind === "let" || kind === "const" || kind === "class") {
      this.uninitializedLocalSlots.add(slot);
    }
  }

  allocTemp(): number {
    return this.registerCount++;
  }

  allocFeedbackSlot(): number {
    return this.feedbackSlotCount++;
  }

  emit(opcode: RegisterOpcode, ...operands: RegisterOperand[]): number {
    const instr = new RegisterInstruction(opcode, ...operands);
    this.instructions.push(instr);
    return this.instructions.length - 1;
  }

  patchJump(instrIndex: number, target: number): void {
    this.instructions[instrIndex]!.operands[0] = target;
  }

  disassemble(): string {
    const header = `=== ${this.name || "<script>"} (params=${this.paramCount}, locals=${this.localCount}, registers=${this.registerCount}, constants=${this.constants.length}) ===`;
    const lines = [header];

    if (this.constants.length > 0) {
      lines.push("Constants:");
      for (let i = 0; i < this.constants.length; i++) {
        const c = this.constants[i];
        const display =
          c instanceof RegisterCompiledFunction
            ? `<function ${c.name || "<anonymous>"}>`
            : JSON.stringify(c);
        lines.push(`  [${i}] ${display}`);
      }
    }

    if (this.localNames.length > 0) {
      lines.push(
        `Locals: ${this.localNames.map((n, i) => `r${i}=${n}`).join(", ")}`,
      );
    }

    lines.push("Instructions:");
    for (let i = 0; i < this.instructions.length; i++) {
      const instr = this.instructions[i]!;
      const name = rOpcodeName(instr.opcode);
      let parts = [name];

      for (let j = 0; j < instr.operands.length; j++) {
        const op = instr.operands[j];
        if (instr.opcode === ROP_LDA_CONST && j === 0) {
          const c = this.constants[op as number];
          const display =
            c instanceof RegisterCompiledFunction
              ? `<function ${c.name || "<anonymous>"}>`
              : JSON.stringify(c);
          parts.push(`[${op}] (${display})`);
        } else if (
          (instr.opcode === ROP_LDA_GLOBAL ||
            instr.opcode === ROP_STA_GLOBAL) &&
          j === 0
        ) {
          parts.push(`[${op}] (${String(this.constants[op as number])})`);
        } else if (
          (instr.opcode === ROP_LDA_PROP || instr.opcode === ROP_STA_PROP) &&
          j === 1
        ) {
          parts.push(`[${op}] (${String(this.constants[op as number])})`);
        } else {
          parts.push(`r${op}`);
        }
      }

      lines.push(`  ${String(i).padStart(4)}  ${parts.join(" ")}`);
    }

    return lines.join("\n");
  }
}

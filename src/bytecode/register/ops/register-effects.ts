import * as ops from "./bytecode.js";
import { RegisterCompiledFunction } from "./bytecode.js";
import type { RegisterOpcode, RegisterOperand } from "./bytecode.js";

export interface RegisterInstructionLike {
  readonly opcode: RegisterOpcode;
  readonly operands: readonly RegisterOperand[];
}

export interface RegisterWindow {
  readonly base: number;
  readonly count: number;
}

export type ControlEffect =
  | "next"
  | "jump"
  | "branch"
  | "terminate"
  | "enter-handler"
  | "leave-handler";

const CONTROL_TARGET_OPERAND = 0;

export interface RegisterEffects {
  readonly reads: readonly number[];
  readonly writes: readonly number[];
  readonly windows: readonly RegisterWindow[];
  readonly readsFrom: number;
  readonly capturesLocals: boolean;
  readonly control: ControlEffect;
}

interface EffectSpec {
  readonly reads?: readonly number[];
  readonly writes?: readonly number[];
  readonly windows?: readonly RegisterWindow[];
  readonly readsFrom?: number;
  readonly capturesLocals?: boolean;
  readonly control?: ControlEffect;
}

const NO_OPERANDS: readonly number[] = [];
const NO_WINDOWS: readonly RegisterWindow[] = [];

function effects(spec: EffectSpec = {}): RegisterEffects {
  return {
    reads: spec.reads ?? NO_OPERANDS,
    writes: spec.writes ?? NO_OPERANDS,
    windows: spec.windows ?? NO_WINDOWS,
    readsFrom: spec.readsFrom ?? Infinity,
    capturesLocals: spec.capturesLocals ?? false,
    control: spec.control ?? "next",
  };
}

const ACCUMULATOR_ONLY = effects();
const READS_FIRST = effects({ reads: [0] });
const READS_FIRST_TWO = effects({ reads: [0, 1] });
const LOADS_FIRST = effects({ writes: [0] });
const MOVES_FIRST_TO_SECOND = effects({ reads: [0], writes: [1] });
const READS_CALLEE_AND_ARGUMENTS = effects({
  reads: [0],
  windows: [{ base: 1, count: 2 }],
});
const READS_CALLEE_AND_NAMED_ARGUMENTS = effects({
  reads: [0],
  windows: [
    { base: 1, count: 2 },
    { base: 3, count: 5 },
  ],
});

const REGISTER_EFFECTS: ReadonlyMap<RegisterOpcode, RegisterEffects> = new Map([
  [ops.ROP_LDA_CONST, ACCUMULATOR_ONLY],
  [ops.ROP_LDA_REG, READS_FIRST],
  [ops.ROP_STAR, LOADS_FIRST],
  [ops.ROP_MOV, MOVES_FIRST_TO_SECOND],

  [ops.ROP_LDA_GLOBAL, ACCUMULATOR_ONLY],
  [ops.ROP_STA_GLOBAL, ACCUMULATOR_ONLY],

  [ops.ROP_LDA_PROP, READS_FIRST],
  [ops.ROP_STA_PROP, READS_FIRST],
  [ops.ROP_DEFINE_CLASS_MEMBER, READS_FIRST],
  [ops.ROP_LDA_INDEX, READS_FIRST_TWO],
  [ops.ROP_STA_INDEX, READS_FIRST_TWO],
  [ops.ROP_STA_COMPUTED_PROP, READS_FIRST_TWO],
  [ops.ROP_DELETE_PROP, effects({ reads: [0, 2] })],
  [ops.ROP_DEFINE_ACCESSOR, effects({ reads: [0, 2, 3] })],
  [ops.ROP_SET_PROTO, READS_FIRST_TWO],
  [ops.ROP_GET_KEYS, READS_FIRST],
  [ops.ROP_GET_LENGTH, READS_FIRST],
  [ops.ROP_LDA_KEYED_SLICE, effects({ reads: [0], readsFrom: 2 })],
  [ops.ROP_ASSERT_CLASS_CONTRACTS, READS_FIRST],

  [ops.ROP_ADD, READS_FIRST],
  [ops.ROP_SUB, READS_FIRST],
  [ops.ROP_MUL, READS_FIRST],
  [ops.ROP_DIV, READS_FIRST],
  [ops.ROP_MOD, READS_FIRST],
  [ops.ROP_POW, READS_FIRST],
  [ops.ROP_MATMUL, READS_FIRST],
  [ops.ROP_BITAND, READS_FIRST],
  [ops.ROP_BITOR, READS_FIRST],
  [ops.ROP_BITXOR, READS_FIRST],
  [ops.ROP_SHL, READS_FIRST],
  [ops.ROP_SHR, READS_FIRST],
  [ops.ROP_USHR, READS_FIRST],
  [ops.ROP_EQ, READS_FIRST],
  [ops.ROP_NEQ, READS_FIRST],
  [ops.ROP_LOOSE_EQ, READS_FIRST],
  [ops.ROP_LOOSE_NEQ, READS_FIRST],
  [ops.ROP_LT, READS_FIRST],
  [ops.ROP_GT, READS_FIRST],
  [ops.ROP_LTE, READS_FIRST],
  [ops.ROP_GTE, READS_FIRST],
  [ops.ROP_INSTANCEOF, READS_FIRST],
  [ops.ROP_IN, READS_FIRST],

  [ops.ROP_NOT, ACCUMULATOR_ONLY],
  [ops.ROP_NEG, ACCUMULATOR_ONLY],
  [ops.ROP_BITNOT, ACCUMULATOR_ONLY],
  [ops.ROP_TYPEOF, ACCUMULATOR_ONLY],
  [ops.ROP_VOID, ACCUMULATOR_ONLY],
  [ops.ROP_IS_NULLISH, ACCUMULATOR_ONLY],

  [ops.ROP_JUMP, effects({ control: "jump" })],
  [ops.ROP_JUMP_IF_FALSE, effects({ control: "branch" })],
  [ops.ROP_JUMP_IF_TRUE, effects({ control: "branch" })],
  [ops.ROP_RETURN, effects({ control: "terminate" })],
  [ops.ROP_TRY_START, effects({ control: "enter-handler" })],
  [ops.ROP_TRY_END, effects({ control: "leave-handler" })],
  [ops.ROP_THROW, effects({ control: "terminate" })],

  [ops.ROP_CALL, READS_CALLEE_AND_ARGUMENTS],
  [ops.ROP_CALL_METHOD, READS_CALLEE_AND_ARGUMENTS],
  [ops.ROP_NEW, READS_CALLEE_AND_ARGUMENTS],
  [ops.ROP_CALL_NAMED, READS_CALLEE_AND_NAMED_ARGUMENTS],
  [ops.ROP_CALL_METHOD_NAMED, READS_CALLEE_AND_NAMED_ARGUMENTS],
  [ops.ROP_CALL_INTRINSIC, effects({ windows: [{ base: 1, count: 2 }] })],
  [ops.ROP_CALL_SPREAD, effects({ reads: [0, 1, 2] })],
  [
    ops.ROP_CALL_SPREAD_NAMED,
    effects({ reads: [0, 1], windows: [{ base: 2, count: 4 }] }),
  ],
  [
    ops.ROP_CALL_METHOD_SPREAD_NAMED,
    effects({ reads: [0, 1, 2], windows: [{ base: 3, count: 5 }] }),
  ],

  [ops.ROP_NEW_OBJECT, ACCUMULATOR_ONLY],
  [ops.ROP_NEW_ARRAY, effects({ windows: [{ base: 0, count: 1 }] })],
  [ops.ROP_NEW_REGEX, ACCUMULATOR_ONLY],
  [ops.ROP_ARRAY_PUSH, READS_FIRST],
  [ops.ROP_SPREAD_ARRAY, READS_FIRST],
  [ops.ROP_COPY_PROPS, READS_FIRST],
  [ops.ROP_ARRAY_REST, ACCUMULATOR_ONLY],
  [ops.ROP_OBJECT_REST, ACCUMULATOR_ONLY],
  [ops.ROP_REST_ARGS, ACCUMULATOR_ONLY],
  [ops.ROP_LOAD_ARGUMENTS, ACCUMULATOR_ONLY],

  [ops.ROP_LDA_UNDEFINED, ACCUMULATOR_ONLY],
  [ops.ROP_LDA_NULL, ACCUMULATOR_ONLY],
  [ops.ROP_LDA_TRUE, ACCUMULATOR_ONLY],
  [ops.ROP_LDA_FALSE, ACCUMULATOR_ONLY],
  [ops.ROP_LDA_THIS, ACCUMULATOR_ONLY],

  [ops.ROP_LDA_UPVALUE, ACCUMULATOR_ONLY],
  [ops.ROP_STA_UPVALUE, ACCUMULATOR_ONLY],
  [ops.ROP_MAKE_CLOSURE, effects({ capturesLocals: true })],
  [ops.ROP_CLOSE_UPVALUES, ACCUMULATOR_ONLY],

  [ops.ROP_AWAIT, ACCUMULATOR_ONLY],
  [ops.ROP_YIELD, ACCUMULATOR_ONLY],
  [ops.ROP_GET_ITERATOR, ACCUMULATOR_ONLY],
  [ops.ROP_ITER_NEXT, ACCUMULATOR_ONLY],
  [ops.ROP_ITER_DONE, ACCUMULATOR_ONLY],
  [ops.ROP_ITER_VALUE, ACCUMULATOR_ONLY],

  [ops.ROP_TEST_FEEDBACK, ACCUMULATOR_ONLY],
]);

export function registerEffectsOf(opcode: RegisterOpcode): RegisterEffects | null {
  return REGISTER_EFFECTS.get(opcode) ?? null;
}

export function controlEffectOf(opcode: RegisterOpcode): ControlEffect | null {
  return registerEffectsOf(opcode)?.control ?? null;
}

function controlTargetOf(
  instruction: RegisterInstructionLike,
  ...taking: readonly ControlEffect[]
): number | null {
  const control = controlEffectOf(instruction.opcode);
  if (control === null || !taking.includes(control)) return null;
  return instruction.operands[CONTROL_TARGET_OPERAND] ?? null;
}

export function jumpTargetOf(instruction: RegisterInstructionLike): number | null {
  return controlTargetOf(instruction, "jump", "branch");
}

export function handlerTargetOf(instruction: RegisterInstructionLike): number | null {
  return controlTargetOf(instruction, "enter-handler");
}

function visitOperandSlot(
  operands: readonly number[],
  index: number,
  visit: (slot: number) => void,
): void {
  const slot = operands[index];
  if (slot === undefined || slot < 0) return;
  visit(slot);
}

export function forEachRegisterRead(
  instruction: RegisterInstructionLike,
  visit: (slot: number) => void,
): void {
  const effect = registerEffectsOf(instruction.opcode);
  if (!effect) return;
  const operands = instruction.operands;
  for (const index of effect.reads) visitOperandSlot(operands, index, visit);
  for (const window of effect.windows) {
    const base = operands[window.base];
    const count = operands[window.count];
    if (base === undefined || count === undefined) continue;
    for (let offset = 0; offset < count; offset++) visit(base + offset);
  }
  for (let index = effect.readsFrom; index < operands.length; index++) {
    visitOperandSlot(operands, index, visit);
  }
}

export function forEachRegisterWrite(
  instruction: RegisterInstructionLike,
  visit: (slot: number) => void,
): void {
  const effect = registerEffectsOf(instruction.opcode);
  if (!effect) return;
  for (const index of effect.writes) {
    visitOperandSlot(instruction.operands, index, visit);
  }
}

export type ClosureCaptureSource = "local" | "upvalue";

export interface ClosureCapture {
  source: ClosureCaptureSource;
  slot: number;
}

function capturedOuterSlot(upvalue: ops.UpvalueDescriptor): number | null {
  const slot = upvalue.outerSlot ?? upvalue.index;
  return typeof slot === "number" ? slot : null;
}

export function closureCaptures(
  target: Pick<RegisterCompiledFunction, "upvalues">,
): ClosureCapture[] {
  const captures: ClosureCapture[] = [];
  for (const upvalue of target.upvalues) {
    if (!upvalue) continue;
    const slot = capturedOuterSlot(upvalue);
    if (slot === null) continue;
    captures.push({
      source:
        upvalue.outerType === "upvalue" || upvalue.isLocal === false
          ? "upvalue"
          : "local",
      slot,
    });
  }
  return captures;
}

export function closureCapturedSlots(
  compiledFn: Pick<RegisterCompiledFunction, "instructions" | "constants">,
): ReadonlySet<number> {
  const slots = new Set<number>();
  for (const instruction of compiledFn.instructions) {
    const effect = registerEffectsOf(instruction.opcode);
    if (!effect?.capturesLocals) continue;
    const target = compiledFn.constants[instruction.operands[0]!];
    if (!(target instanceof RegisterCompiledFunction)) continue;
    for (const capture of closureCaptures(target)) {
      if (capture.source === "local") slots.add(capture.slot);
    }
  }
  return slots;
}

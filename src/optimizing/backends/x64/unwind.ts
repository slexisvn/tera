import { bytesFragment, type McFragment, type McInstructionFragment } from "../../mc/fragment.js";
import { fixup } from "../../mc/fixup.js";
import type { McModule } from "../../mc/module.js";
import type { AssembledFunction } from "../../mc/assembler.js";
import type { MachineInstruction, MachineOperand } from "../../machine/ir.js";
import {
  appendEhFrame,
  type EhFrameTarget,
  type FrameDescription,
  type PrologueEffect,
  type PrologueStep,
} from "../../mc/dwarf/eh-frame.js";
import { X64_FIELD_RELATIVE_32, X64_IMAGE_RELATIVE_32 } from "./mc/fixups.js";

export const PDATA_SECTION = ".pdata";
export const XDATA_SECTION = ".xdata";

const UNWIND_VERSION = 1;
const UWOP_ALLOC_LARGE = 1;
const UWOP_ALLOC_SMALL = 2;
const UWOP_SAVE_NONVOL = 4;
const SMALL_ALLOC_LIMIT = 128;
const SLOT_BYTES = 8;
const RUNTIME_FUNCTION_BYTES = 12;

const WIN64_REGISTER_NUMBERS: ReadonlyMap<string, number> = new Map([
  ["rax", 0],
  ["rcx", 1],
  ["rdx", 2],
  ["rbx", 3],
  ["rsp", 4],
  ["rbp", 5],
  ["rsi", 6],
  ["rdi", 7],
  ["r8", 8],
  ["r9", 9],
  ["r10", 10],
  ["r11", 11],
  ["r12", 12],
  ["r13", 13],
  ["r14", 14],
  ["r15", 15],
]);

const DWARF_REGISTER_NUMBERS: ReadonlyMap<string, number> = new Map([
  ["rax", 0],
  ["rdx", 1],
  ["rcx", 2],
  ["rbx", 3],
  ["rsi", 4],
  ["rdi", 5],
  ["rbp", 6],
  ["rsp", 7],
  ["r8", 8],
  ["r9", 9],
  ["r10", 10],
  ["r11", 11],
  ["r12", 12],
  ["r13", 13],
  ["r14", 14],
  ["r15", 15],
]);

const DWARF_RETURN_ADDRESS = 16;

export const x64CfiTarget: EhFrameTarget = {
  stackPointer: DWARF_REGISTER_NUMBERS.get("rsp")!,
  returnAddress: DWARF_RETURN_ADDRESS,
  initialCfaOffset: SLOT_BYTES,
  returnAddressAtEntry: SLOT_BYTES,
  codeAlignment: 1,
  slotBytes: SLOT_BYTES,
  pointerFixup: X64_FIELD_RELATIVE_32,
  numberOf: (register) => DWARF_REGISTER_NUMBERS.get(register) ?? null,
};

function registerNameOf(operand: MachineOperand | undefined): string | null {
  if (operand === undefined || operand.kind !== "register") return null;
  const register = operand.register;
  return register.kind === "physical" ? register.name : null;
}

function stackDisplacementOf(operand: MachineOperand | undefined): number | null {
  if (operand === undefined || operand.kind !== "memory") return null;
  const address = operand.address;
  if (registerNameOf(address.base ?? undefined) !== "rsp" || address.index !== null) return null;
  return address.displacement;
}

function allocationEffect(node: MachineInstruction): PrologueEffect | null {
  if (node.opcode !== "subq") return null;
  const amount = node.operands.find((operand) => operand.kind === "immediate");
  if (registerNameOf(node.operands[0]) !== "rsp" || amount === undefined) return null;
  const bytes = Number(amount.value);
  if (bytes <= 0 || bytes % SLOT_BYTES !== 0) return null;
  return { kind: "allocate", bytes };
}

function saveEffect(node: MachineInstruction): PrologueEffect | null {
  if (node.opcode !== "movq") return null;
  const [location, source] = node.operands;
  const displacement = stackDisplacementOf(location);
  const saved = registerNameOf(source);
  if (displacement === null || saved === null || displacement % SLOT_BYTES !== 0) return null;
  if (!WIN64_REGISTER_NUMBERS.has(saved)) return null;
  return { kind: "save", register: saved, offset: displacement };
}

export function prologueEffectOf(node: MachineInstruction): PrologueEffect | null {
  return allocationEffect(node) ?? saveEffect(node);
}

export function prologueStepsOf(
  prologue: readonly McInstructionFragment[],
): PrologueStep[] | null {
  const steps: PrologueStep[] = [];
  for (const fragment of prologue) {
    const effect = prologueEffectOf(fragment.node);
    if (effect === null) return null;
    steps.push({ effect, fragment });
  }
  return steps;
}

interface WindowsCode {
  readonly op: number;
  readonly info: number;
  readonly extra: readonly number[];
  offset: number;
  readonly fragment: McInstructionFragment;
}

function windowsCode(step: PrologueStep): WindowsCode | null {
  if (step.effect.kind === "allocate") {
    const slots = step.effect.bytes / SLOT_BYTES;
    const described =
      step.effect.bytes <= SMALL_ALLOC_LIMIT
        ? { op: UWOP_ALLOC_SMALL, info: slots - 1, extra: [] as number[] }
        : { op: UWOP_ALLOC_LARGE, info: 0, extra: [slots] };
    return { ...described, offset: 0, fragment: step.fragment };
  }
  const number = WIN64_REGISTER_NUMBERS.get(step.effect.register);
  if (number === undefined) return null;
  return {
    op: UWOP_SAVE_NONVOL,
    info: number,
    extra: [step.effect.offset / SLOT_BYTES],
    offset: 0,
    fragment: step.fragment,
  };
}

function windowsCodesOf(steps: readonly PrologueStep[]): WindowsCode[] | null {
  const codes: WindowsCode[] = [];
  for (const step of steps) {
    const code = windowsCode(step);
    if (code === null) return null;
    codes.push(code);
  }
  return codes;
}

function unwindInfoBytes(codes: readonly WindowsCode[], prologueSize: number): number[] {
  const encoded: number[] = [];
  for (const code of [...codes].reverse()) {
    encoded.push(code.offset & 0xff, (code.op & 0x0f) | ((code.info & 0x0f) << 4));
    for (const extra of code.extra) encoded.push(extra & 0xff, (extra >> 8) & 0xff);
  }
  const slots = encoded.length / 2;
  if (slots % 2 === 1) encoded.push(0, 0);
  return [UNWIND_VERSION, prologueSize & 0xff, slots, 0, ...encoded];
}

function describedSize(codes: readonly WindowsCode[]): number {
  let slots = 0;
  for (const code of codes) slots += 1 + code.extra.length;
  return 4 + (slots + (slots % 2)) * 2;
}

export interface UnwindEntry {
  readonly symbol: string;
  readonly assembled: AssembledFunction;
}

interface PendingRecord {
  readonly codes: readonly WindowsCode[];
  readonly record: { bytes: number[] };
  readonly entry: McFragment;
}

export function appendWin64Unwind(
  module: McModule,
  functions: readonly UnwindEntry[],
): () => void {
  const pending: PendingRecord[] = [];
  const xdata = module.section(XDATA_SECTION, "rodata", 4);
  const pdata = module.section(PDATA_SECTION, "rodata", 4);

  for (const { symbol, assembled } of functions) {
    const steps = prologueStepsOf(assembled.prologue);
    const codes = steps === null ? null : windowsCodesOf(steps);
    if (codes === null || codes.length === 0) continue;
    const label = `.xunwind$${symbol}`;
    const record = xdata.add(bytesFragment(new Array<number>(describedSize(codes)).fill(0)));
    module.symbols.define(label, record, "local", "none");
    const endLabel = `.xend$${symbol}`;
    module.symbols.define(endLabel, assembled.end, "local", "none");
    pdata.add(
      bytesFragment(new Array<number>(RUNTIME_FUNCTION_BYTES).fill(0), [
        fixup(0, X64_IMAGE_RELATIVE_32, symbol),
        fixup(4, X64_IMAGE_RELATIVE_32, endLabel),
        fixup(8, X64_IMAGE_RELATIVE_32, label),
      ]),
    );
    pending.push({ codes, record, entry: assembled.entry });
  }

  return () => {
    for (const { codes, record, entry } of pending) {
      let prologueSize = 0;
      for (const code of codes) {
        code.offset = code.fragment.address + code.fragment.size - entry.address;
        prologueSize = Math.max(prologueSize, code.offset);
      }
      const bytes = unwindInfoBytes(codes, prologueSize);
      for (let at = 0; at < record.bytes.length; at++) record.bytes[at] = bytes[at] ?? 0;
    }
  };
}

export function appendX64EhFrame(
  module: McModule,
  functions: readonly UnwindEntry[],
  withHeader: boolean,
): () => void {
  const described: FrameDescription[] = [];
  for (const { symbol, assembled } of functions) {
    const steps = prologueStepsOf(assembled.prologue);
    if (steps === null || steps.length === 0) continue;
    described.push({ symbol, entry: assembled.entry, end: assembled.end, steps });
  }
  return appendEhFrame(module, x64CfiTarget, described, withHeader);
}

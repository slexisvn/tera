import { writeInteger } from "../buffer.js";
import { fixup, type FixupKind } from "../fixup.js";
import { bytesFragment, type McBytesFragment, type McFragment, type McInstructionFragment } from "../fragment.js";
import type { McModule } from "../module.js";

export const EH_FRAME_SECTION = ".eh_frame";
export const EH_FRAME_HEADER_SECTION = ".eh_frame_hdr";

const DW_CFA_NOP = 0x00;
const DW_CFA_ADVANCE_LOC4 = 0x04;
const DW_CFA_DEF_CFA = 0x0c;
const DW_CFA_DEF_CFA_OFFSET = 0x0e;
const DW_CFA_OFFSET = 0x80;
const DW_EH_PE_PCREL_SDATA4 = 0x1b;
const DW_EH_PE_UDATA4 = 0x03;
const DW_EH_PE_DATAREL_SDATA4 = 0x3b;

const CIE_VERSION = 1;
const CIE_AUGMENTATION = [0x7a, 0x52, 0x00];
const ENTRY_ALIGNMENT = 8;
const LENGTH_BYTES = 4;
const HEADER_VERSION = 1;
const HEADER_PREFIX_BYTES = 12;
const TABLE_ENTRY_BYTES = 8;
const TERMINATOR = [0, 0, 0, 0];
const CIE_IDENTIFIER = [0, 0, 0, 0];

export type PrologueEffect =
  | { readonly kind: "allocate"; readonly bytes: number }
  | { readonly kind: "save"; readonly register: string; readonly offset: number };

export interface PrologueStep {
  readonly effect: PrologueEffect;
  readonly fragment: McInstructionFragment;
}

export interface FrameDescription {
  readonly symbol: string;
  readonly entry: McFragment;
  readonly end: McFragment;
  readonly steps: readonly PrologueStep[];
}

export interface CfiTarget {
  readonly stackPointer: number;
  readonly returnAddress: number;
  readonly initialCfaOffset: number;
  readonly returnAddressAtEntry: number | null;
  readonly codeAlignment: number;
  readonly slotBytes: number;
  numberOf(register: string): number | null;
}

export interface EhFrameTarget extends CfiTarget {
  readonly pointerFixup: FixupKind;
}

export function uleb128(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    const digit = rest & 0x7f;
    rest >>>= 7;
    bytes.push(rest === 0 ? digit : digit | 0x80);
  } while (rest !== 0);
  return bytes;
}

export function sleb128(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  for (;;) {
    const digit = rest & 0x7f;
    rest >>= 7;
    const signed = (digit & 0x40) !== 0;
    if ((rest === 0 && !signed) || (rest === -1 && signed)) {
      bytes.push(digit);
      return bytes;
    }
    bytes.push(digit | 0x80);
  }
}

function paddedTo(bytes: readonly number[], alignment: number): number[] {
  const padded = [...bytes];
  while (padded.length % alignment !== 0) padded.push(DW_CFA_NOP);
  return padded;
}

function cieBytes(target: EhFrameTarget): number[] {
  const initial = [
    DW_CFA_DEF_CFA,
    ...uleb128(target.stackPointer),
    ...uleb128(target.initialCfaOffset),
  ];
  if (target.returnAddressAtEntry !== null) {
    initial.push(
      DW_CFA_OFFSET | target.returnAddress,
      ...uleb128(target.returnAddressAtEntry / target.slotBytes),
    );
  }
  const body = [
    ...TERMINATOR,
    ...CIE_IDENTIFIER,
    CIE_VERSION,
    ...CIE_AUGMENTATION,
    ...uleb128(target.codeAlignment),
    ...sleb128(-target.slotBytes),
    ...uleb128(target.returnAddress),
    ...uleb128(1),
    DW_EH_PE_PCREL_SDATA4,
    ...initial,
  ];
  const entry = paddedTo(body, ENTRY_ALIGNMENT);
  writeInteger(entry, 0, entry.length - LENGTH_BYTES, LENGTH_BYTES);
  return entry;
}

interface EncodedStep {
  readonly step: PrologueStep;
  readonly deltaAt: number;
}

interface PendingFrame {
  readonly description: FrameDescription;
  readonly record: McBytesFragment;
  readonly encoded: readonly EncodedStep[];
}

export type CfaChange =
  | { readonly kind: "cfa"; readonly offset: number }
  | { readonly kind: "saved"; readonly register: number; readonly slots: number };

export function describeSteps(
  steps: readonly PrologueEffect[],
  target: CfiTarget,
): CfaChange[] | null {
  const changes: CfaChange[] = [];
  let cfaOffset = target.initialCfaOffset;
  for (const effect of steps) {
    if (effect.kind === "allocate") {
      cfaOffset += effect.bytes;
      changes.push({ kind: "cfa", offset: cfaOffset });
      continue;
    }
    const register = target.numberOf(effect.register);
    const distance = cfaOffset - effect.offset;
    if (register === null || register > 0x3f) return null;
    if (distance <= 0 || distance % target.slotBytes !== 0) return null;
    changes.push({ kind: "saved", register, slots: distance / target.slotBytes });
  }
  return changes;
}

function frameInstructions(
  description: FrameDescription,
  target: EhFrameTarget,
  origin: number,
): { bytes: number[]; encoded: EncodedStep[] } | null {
  const changes = describeSteps(
    description.steps.map((step) => step.effect),
    target,
  );
  if (changes === null) return null;
  const bytes: number[] = [];
  const encoded: EncodedStep[] = [];
  changes.forEach((change, position) => {
    const operands =
      change.kind === "cfa"
        ? [DW_CFA_DEF_CFA_OFFSET, ...uleb128(change.offset)]
        : [DW_CFA_OFFSET | change.register, ...uleb128(change.slots)];
    encoded.push({ step: description.steps[position]!, deltaAt: origin + bytes.length + 1 });
    bytes.push(DW_CFA_ADVANCE_LOC4, 0, 0, 0, 0, ...operands);
  });
  return { bytes, encoded };
}

export function cfiDirectives(
  steps: readonly PrologueEffect[],
  target: CfiTarget,
): string[][] | null {
  const changes = describeSteps(steps, target);
  if (changes === null) return null;
  return changes.map((change) =>
    change.kind === "cfa"
      ? [`\t.cfi_def_cfa_offset ${change.offset}`]
      : [`\t.cfi_offset ${change.register}, ${-change.slots * target.slotBytes}`],
  );
}

function fdeFragment(
  description: FrameDescription,
  target: EhFrameTarget,
): PendingFrame | null {
  const head = [...TERMINATOR, ...TERMINATOR, ...TERMINATOR, ...TERMINATOR, 0];
  const described = frameInstructions(description, target, head.length);
  if (described === null) return null;
  const entry = paddedTo([...head, ...described.bytes], ENTRY_ALIGNMENT);
  writeInteger(entry, 0, entry.length - LENGTH_BYTES, LENGTH_BYTES);
  const record = bytesFragment(entry, [
    fixup(LENGTH_BYTES * 2, target.pointerFixup, description.symbol),
  ]);
  return { description, record, encoded: described.encoded };
}

function patchFrame(pending: PendingFrame, cie: McBytesFragment): void {
  const { description, record, encoded } = pending;
  const bytes = record.bytes;
  writeInteger(bytes, LENGTH_BYTES, record.address + LENGTH_BYTES - cie.address, LENGTH_BYTES);
  const start = description.entry.address;
  writeInteger(bytes, LENGTH_BYTES * 3, description.end.address - start, LENGTH_BYTES);
  let location = 0;
  for (const { step, deltaAt } of encoded) {
    const reached = step.fragment.address + step.fragment.size - start;
    writeInteger(bytes, deltaAt, reached - location, LENGTH_BYTES);
    location = reached;
  }
}

function headerFragment(count: number): McBytesFragment {
  return bytesFragment([
    HEADER_VERSION,
    DW_EH_PE_PCREL_SDATA4,
    DW_EH_PE_UDATA4,
    DW_EH_PE_DATAREL_SDATA4,
    ...new Array<number>(LENGTH_BYTES * 2 + count * TABLE_ENTRY_BYTES).fill(0),
  ]);
}

function patchHeader(
  header: McBytesFragment,
  cie: McBytesFragment,
  frames: readonly PendingFrame[],
): void {
  const bytes = header.bytes;
  const origin = header.address;
  writeInteger(bytes, LENGTH_BYTES, cie.address - (origin + LENGTH_BYTES), LENGTH_BYTES);
  writeInteger(bytes, LENGTH_BYTES * 2, frames.length, LENGTH_BYTES);
  const sorted = [...frames].sort(
    (left, right) => left.description.entry.address - right.description.entry.address,
  );
  sorted.forEach((frame, position) => {
    const at = HEADER_PREFIX_BYTES + position * TABLE_ENTRY_BYTES;
    writeInteger(bytes, at, frame.description.entry.address - origin, LENGTH_BYTES);
    writeInteger(bytes, at + LENGTH_BYTES, frame.record.address - origin, LENGTH_BYTES);
  });
}

export function appendEhFrame(
  module: McModule,
  target: EhFrameTarget,
  functions: readonly FrameDescription[],
  withHeader: boolean,
): () => void {
  const described = functions.flatMap((description) => {
    const pending = fdeFragment(description, target);
    return pending === null ? [] : [pending];
  });
  if (described.length === 0) return () => {};

  const frames = module.section(EH_FRAME_SECTION, "rodata", ENTRY_ALIGNMENT);
  const cie = frames.add(bytesFragment(cieBytes(target)));
  for (const pending of described) frames.add(pending.record);
  frames.add(bytesFragment(TERMINATOR));

  const header = withHeader
    ? module.section(EH_FRAME_HEADER_SECTION, "rodata", LENGTH_BYTES).add(headerFragment(described.length))
    : null;

  return () => {
    for (const pending of described) patchFrame(pending, cie);
    if (header !== null) patchHeader(header, cie, described);
  };
}

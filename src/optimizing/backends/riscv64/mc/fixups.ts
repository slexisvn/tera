import { fitsSigned } from "../../../mc/buffer.js";
import { MachineCodeError } from "../../../mc/errors.js";
import type {
  FixupAnchor,
  FixupKind,
  FixupModel,
  RelocationFlavor,
} from "../../../mc/fixup.js";

export const RISCV_BRANCH_12 = "riscv.branch12";
export const RISCV_JUMP_20 = "riscv.jump20";
export const RISCV_CALL_32 = "riscv.call32";
export const RISCV_PCREL_HI20 = "riscv.pcrelHi20";
export const RISCV_PCREL_LO12_I = "riscv.pcrelLo12i";
export const RISCV_PCREL_LO12_S = "riscv.pcrelLo12s";
export const RISCV_ABSOLUTE_64 = "riscv.abs64";

export const R_RISCV_32 = 1;
export const R_RISCV_64 = 2;
export const R_RISCV_BRANCH = 16;
export const R_RISCV_JAL = 17;
export const R_RISCV_CALL_PLT = 19;
export const R_RISCV_PCREL_HI20 = 23;
export const R_RISCV_PCREL_LO12_I = 24;
export const R_RISCV_PCREL_LO12_S = 25;

const INSTRUCTION_BYTES = 4;
const DOUBLE_WORD_BYTES = 8;

interface FixupSpec {
  readonly anchor: FixupAnchor;
  readonly size: number;
  readonly bits: number;
  readonly relocation: number;
}

const WORD: Omit<FixupSpec, "bits" | "relocation"> = {
  anchor: "instructionStart",
  size: INSTRUCTION_BYTES,
};

const SPECS = new Map<FixupKind, FixupSpec>([
  [RISCV_BRANCH_12, { ...WORD, bits: 13, relocation: R_RISCV_BRANCH }],
  [RISCV_JUMP_20, { ...WORD, bits: 21, relocation: R_RISCV_JAL }],
  [RISCV_CALL_32, { ...WORD, bits: 32, relocation: R_RISCV_CALL_PLT }],
  [RISCV_PCREL_HI20, { ...WORD, bits: 32, relocation: R_RISCV_PCREL_HI20 }],
  [RISCV_PCREL_LO12_I, { ...WORD, bits: 32, relocation: R_RISCV_PCREL_LO12_I }],
  [RISCV_PCREL_LO12_S, { ...WORD, bits: 32, relocation: R_RISCV_PCREL_LO12_S }],
  [
    RISCV_ABSOLUTE_64,
    { anchor: "absolute", size: DOUBLE_WORD_BYTES, bits: 64, relocation: R_RISCV_64 },
  ],
]);

function specOf(kind: FixupKind): FixupSpec {
  const spec = SPECS.get(kind);
  if (spec === undefined) throw new MachineCodeError(`unknown riscv64 fixup ${kind}`);
  return spec;
}

const RELOCATABLE: readonly RelocationFlavor[] = ["elf"];

export const riscv64FixupModel: FixupModel = {
  anchorOf: (kind) => specOf(kind).anchor,
  sizeOf: (kind) => specOf(kind).size,
  fits: (kind, value) => fitsSigned(value, specOf(kind).bits),
  apply: (kind) => {
    throw new MachineCodeError(`riscv64 cannot yet apply ${kind}`);
  },
  relocationOf: (kind, flavor) =>
    RELOCATABLE.includes(flavor) ? specOf(kind).relocation : null,
};

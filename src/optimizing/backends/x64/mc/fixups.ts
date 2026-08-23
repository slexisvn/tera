import { fitsSigned, writeInteger } from "../../../mc/buffer.js";
import { MachineCodeError } from "../../../mc/errors.js";
import type {
  FixupAnchor,
  FixupKind,
  FixupModel,
  RelocationFlavor,
} from "../../../mc/fixup.js";

export const X64_PC_RELATIVE_8 = "x64.pcrel8";
export const X64_PC_RELATIVE_32 = "x64.pcrel32";
export const X64_BRANCH_32 = "x64.branch32";
export const X64_ABSOLUTE_32 = "x64.abs32";
export const X64_ABSOLUTE_64 = "x64.abs64";
export const X64_IMAGE_RELATIVE_32 = "x64.rva32";
export const X64_FIELD_RELATIVE_32 = "x64.fieldrel32";

export const R_X86_64_64 = 1;
export const R_X86_64_PC32 = 2;
export const R_X86_64_PLT32 = 4;
export const R_X86_64_32S = 11;

export const IMAGE_REL_AMD64_ADDR64 = 0x0001;
export const IMAGE_REL_AMD64_ADDR32 = 0x0002;
export const IMAGE_REL_AMD64_ADDR32NB = 0x0003;
export const IMAGE_REL_AMD64_REL32 = 0x0004;

type RelocationNumbers = Readonly<Record<RelocationFlavor, number | null>>;

interface FixupSpec {
  readonly anchor: FixupAnchor;
  readonly size: number;
  readonly bits: number;
  readonly relocations: RelocationNumbers;
}

const UNRELOCATABLE: RelocationNumbers = { elf: null, coff: null };

const SPECS = new Map<FixupKind, FixupSpec>([
  [
    X64_PC_RELATIVE_8,
    { anchor: "instructionEnd", size: 1, bits: 8, relocations: UNRELOCATABLE },
  ],
  [
    X64_PC_RELATIVE_32,
    {
      anchor: "instructionEnd",
      size: 4,
      bits: 32,
      relocations: { elf: R_X86_64_PC32, coff: IMAGE_REL_AMD64_REL32 },
    },
  ],
  [
    X64_BRANCH_32,
    {
      anchor: "instructionEnd",
      size: 4,
      bits: 32,
      relocations: { elf: R_X86_64_PLT32, coff: IMAGE_REL_AMD64_REL32 },
    },
  ],
  [
    X64_ABSOLUTE_32,
    {
      anchor: "absolute",
      size: 4,
      bits: 32,
      relocations: { elf: R_X86_64_32S, coff: IMAGE_REL_AMD64_ADDR32 },
    },
  ],
  [
    X64_IMAGE_RELATIVE_32,
    {
      anchor: "imageRelative",
      size: 4,
      bits: 32,
      relocations: { elf: null, coff: IMAGE_REL_AMD64_ADDR32NB },
    },
  ],
  [
    X64_FIELD_RELATIVE_32,
    {
      anchor: "fieldRelative",
      size: 4,
      bits: 32,
      relocations: { elf: R_X86_64_PC32, coff: null },
    },
  ],
  [
    X64_ABSOLUTE_64,
    {
      anchor: "absolute",
      size: 8,
      bits: 64,
      relocations: { elf: R_X86_64_64, coff: IMAGE_REL_AMD64_ADDR64 },
    },
  ],
]);

function specOf(kind: FixupKind): FixupSpec {
  const spec = SPECS.get(kind);
  if (spec === undefined) throw new MachineCodeError(`unknown x64 fixup ${kind}`);
  return spec;
}

export const x64FixupModel: FixupModel = {
  anchorOf: (kind) => specOf(kind).anchor,
  sizeOf: (kind) => specOf(kind).size,
  fits: (kind, value) => fitsSigned(value, specOf(kind).bits),
  apply: (kind, bytes, offset, value) => {
    writeInteger(bytes, offset, value, specOf(kind).size);
  },
  relocationOf: (kind, flavor) => specOf(kind).relocations[flavor],
};

import { UnsupportedInstructionError } from "../../../mc/errors.js";
import type { McTarget } from "../../../mc/target.js";
import { riscv64FixupModel } from "./fixups.js";

const NOP: readonly number[] = [0x13, 0x00, 0x00, 0x00];

function riscvPadding(byteCount: number): readonly number[] {
  const bytes: number[] = [];
  while (bytes.length + NOP.length <= byteCount) bytes.push(...NOP);
  while (bytes.length < byteCount) bytes.push(0);
  return bytes;
}

const TARGET = "riscv64";

export const riscv64McTarget: McTarget = {
  name: TARGET,
  endian: "little",
  pointerWidthBytes: 8,
  functionAlignment: 4,
  fixups: riscv64FixupModel,
  formsOf: () => 1,
  encode: (node) => {
    throw new UnsupportedInstructionError(TARGET, node.opcode);
  },
  padding: riscvPadding,
};

import type { MachineInstruction } from "../machine/ir.js";
import type { Endian } from "./buffer.js";
import type { EncodedInstruction, FixupModel } from "./fixup.js";

export interface McTarget {
  readonly name: string;
  readonly endian: Endian;
  readonly pointerWidthBytes: number;
  readonly functionAlignment: number;
  readonly fixups: FixupModel;
  formsOf(node: MachineInstruction): number;
  encode(node: MachineInstruction, form: number): EncodedInstruction;
  padding(byteCount: number): readonly number[];
}

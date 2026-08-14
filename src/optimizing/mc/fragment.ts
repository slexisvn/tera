import type { MachineInstruction } from "../machine/ir.js";
import type { EncodedInstruction, McFixup } from "./fixup.js";

export interface McFragmentBase {
  address: number;
  size: number;
}

export interface McBytesFragment extends McFragmentBase {
  readonly kind: "bytes";
  readonly bytes: number[];
  readonly fixups: readonly McFixup[];
}

export interface McInstructionFragment extends McFragmentBase {
  readonly kind: "instruction";
  readonly node: MachineInstruction;
  form: number;
  bytes: number[];
  fixups: readonly McFixup[];
}

export interface McAlignFragment extends McFragmentBase {
  readonly kind: "align";
  readonly alignment: number;
}

export type McFragment = McBytesFragment | McInstructionFragment | McAlignFragment;

export function bytesFragment(
  bytes: readonly number[],
  fixups: readonly McFixup[] = [],
): McBytesFragment {
  return { kind: "bytes", address: 0, size: bytes.length, bytes: [...bytes], fixups };
}

export function instructionFragment(
  node: MachineInstruction,
  encoding: EncodedInstruction,
  form = 0,
): McInstructionFragment {
  return {
    kind: "instruction",
    address: 0,
    size: encoding.bytes.length,
    node,
    form,
    bytes: [...encoding.bytes],
    fixups: encoding.fixups,
  };
}

export function alignFragment(alignment: number): McAlignFragment {
  return { kind: "align", address: 0, size: 0, alignment };
}

export function paddingFor(address: number, alignment: number): number {
  if (alignment <= 1) return 0;
  return (alignment - (address % alignment)) % alignment;
}

export function fixupsOf(fragment: McFragment): readonly McFixup[] {
  if (fragment.kind === "bytes") return fragment.fixups;
  if (fragment.kind === "instruction") return fragment.fixups;
  return [];
}

export function writableBytesOf(fragment: McFragment): number[] | null {
  if (fragment.kind === "bytes") return fragment.bytes;
  if (fragment.kind === "instruction") return fragment.bytes;
  return null;
}

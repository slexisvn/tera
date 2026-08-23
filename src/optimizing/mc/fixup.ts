import { UnsupportedRelocationError } from "./errors.js";

export type FixupKind = string;

export type FixupAnchor =
  | "absolute"
  | "imageRelative"
  | "fieldRelative"
  | "instructionStart"
  | "instructionEnd";

export type RelocationFlavor = "elf" | "coff";

export interface McFixup {
  readonly offset: number;
  readonly kind: FixupKind;
  readonly symbol: string;
  readonly addend: number;
}

export interface EncodedInstruction {
  readonly bytes: readonly number[];
  readonly fixups: readonly McFixup[];
}

export interface FixupModel {
  anchorOf(kind: FixupKind): FixupAnchor;
  sizeOf(kind: FixupKind): number;
  fits(kind: FixupKind, value: number): boolean;
  apply(kind: FixupKind, bytes: number[], offset: number, value: number): void;
  relocationOf(kind: FixupKind, flavor: RelocationFlavor): number | null;
}

export function relocationTypeOf(
  model: FixupModel,
  kind: FixupKind,
  flavor: RelocationFlavor,
  symbol: string,
): number {
  const type = model.relocationOf(kind, flavor);
  if (type === null) throw new UnsupportedRelocationError(kind, flavor, symbol);
  return type;
}

export function fixup(
  offset: number,
  kind: FixupKind,
  symbol: string,
  addend = 0,
): McFixup {
  return { offset, kind, symbol, addend };
}

export function encoded(
  bytes: readonly number[],
  fixups: readonly McFixup[] = [],
): EncodedInstruction {
  return { bytes, fixups };
}

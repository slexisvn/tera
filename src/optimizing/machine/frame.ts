import type { MachineTargetModel } from "../target/model.js";
import type { PhysicalRegister } from "../target/registers.js";
import type { MachineFunction, StackSlot } from "./ir.js";

export interface SavedRegister {
  readonly register: PhysicalRegister;
  readonly offset: number;
}

export interface FrameLayout {
  readonly outgoingBytes: number;
  readonly localBytes: number;
  readonly frameSize: number;
  readonly saved: readonly SavedRegister[];
  readonly roots: number;
  readonly rootFrame: StackSlot | null;
}

function alignUp(value: number, alignment: number): number {
  return alignment <= 1 ? value : Math.ceil(value / alignment) * alignment;
}

export function layoutFrame(
  fn: MachineFunction,
  target: MachineTargetModel,
  usedCalleeSaved: readonly PhysicalRegister[],
): FrameLayout {
  const abi = target.abi;
  const outgoingBytes = alignUp(fn.outgoingBytes, abi.pointerWidthBytes);

  let cursor = outgoingBytes;
  for (const slot of fn.slots) {
    if (slot.kind !== "local") continue;
    cursor = alignUp(cursor, slot.alignment);
    slot.offset = cursor;
    cursor += slot.size;
  }
  const localBytes = cursor - outgoingBytes;

  const preserved = new Set<PhysicalRegister>(usedCalleeSaved);
  if (fn.hasCalls) for (const register of abi.savedOnCall) preserved.add(register);

  const saved: SavedRegister[] = [];
  for (const register of preserved) {
    const bytes = target.registers.classOf(register.classId).saveBytes;
    cursor = alignUp(cursor, bytes);
    saved.push({ register, offset: cursor });
    cursor += bytes;
  }

  const frameSize =
    alignUp(cursor + abi.entryStackAdjustBytes, abi.stackAlignmentBytes) -
    abi.entryStackAdjustBytes;

  for (const slot of fn.slots) {
    if (slot.kind !== "incoming") continue;
    slot.offset = frameSize + abi.entryStackAdjustBytes + slot.offset;
  }

  return {
    outgoingBytes,
    localBytes,
    frameSize,
    saved,
    roots: fn.roots,
    rootFrame: fn.rootFrame,
  };
}

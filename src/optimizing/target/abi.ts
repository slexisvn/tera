import { alignUp } from "../mc/buffer.js";
import type { PhysicalRegister, RegisterClassId } from "./registers.js";

export interface CallingConvention {
  readonly name: string;
  readonly argumentRegisters: ReadonlyMap<RegisterClassId, readonly PhysicalRegister[]>;
  readonly returnRegisters: ReadonlyMap<RegisterClassId, PhysicalRegister>;
  readonly callerSaved: readonly PhysicalRegister[];
  readonly calleeSaved: readonly PhysicalRegister[];
  readonly sharedArgumentPositions: boolean;
  readonly shadowSpaceBytes: number;
  readonly stackArgumentSlotBytes: number;
}

export const STACK_GUARD_GRANULE_BYTES = 1 << 12;

export interface RuntimeAbi {
  readonly name: string;
  readonly pointerWidthBytes: number;
  readonly stackAlignmentBytes: number;
  readonly entryStackAdjustBytes: number;
  readonly stackProbeBytes: number;
  readonly framePointer: PhysicalRegister;
  readonly stackPointer: PhysicalRegister;
  readonly savedOnCall: readonly PhysicalRegister[];
  readonly callingConvention: CallingConvention;
}

export function calleeFrameBytes(abi: RuntimeAbi, savedRegisters: number): number {
  const pushed = (1 + savedRegisters) * abi.pointerWidthBytes;
  const shadow = abi.callingConvention.shadowSpaceBytes;
  return alignUp(shadow + pushed, abi.stackAlignmentBytes) - pushed;
}

export type ArgumentLocation =
  | { readonly kind: "register"; readonly register: PhysicalRegister }
  | { readonly kind: "stack"; readonly offset: number };

export function argumentLocations(
  convention: CallingConvention,
  classes: readonly RegisterClassId[],
): readonly ArgumentLocation[] {
  const consumed = new Map<RegisterClassId, number>();
  const locations: ArgumentLocation[] = [];
  let stacked = 0;

  for (let position = 0; position < classes.length; position++) {
    const classId = classes[position]!;
    const available = convention.argumentRegisters.get(classId) ?? [];
    const taken = convention.sharedArgumentPositions
      ? position
      : consumed.get(classId) ?? 0;
    const register = available[taken];
    if (register === undefined) {
      locations.push({
        kind: "stack",
        offset: convention.shadowSpaceBytes + stacked * convention.stackArgumentSlotBytes,
      });
      stacked++;
    } else {
      locations.push({ kind: "register", register });
      consumed.set(classId, taken + 1);
    }
  }

  return Object.freeze(locations);
}

export function outgoingArgumentBytes(
  convention: CallingConvention,
  locations: readonly ArgumentLocation[],
): number {
  let stacked = 0;
  for (const location of locations) {
    if (location.kind === "stack") stacked++;
  }
  if (stacked === 0 && convention.shadowSpaceBytes === 0) return 0;
  return convention.shadowSpaceBytes + stacked * convention.stackArgumentSlotBytes;
}

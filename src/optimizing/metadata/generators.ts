import type { ClassShape, ClassTable } from "./class-table.js";
import { syntheticSurface, type CoroutineSlot } from "./coroutines.js";

export const GEN_STATE_FIELD = "state";
export const GEN_STATUS_FIELD = "status";
export const GEN_VALUE_FIELD = "yielded";

export const GEN_ENTRY_STATE = 0;
export const GEN_RUNNING = 0;
export const GEN_FINISHED = 1;

export function generatorFrameName(fn: string): string {
  return `${fn}$generator`;
}

export function generatorResumeName(fn: string): string {
  return `${fn}$step`;
}

export function generatorFrameShape(
  classes: ClassTable,
  fn: string,
  slots: readonly CoroutineSlot[],
  yields: string,
): ClassShape {
  return classes.defineSynthetic(
    syntheticSurface(generatorFrameName(fn), null, [
      [GEN_STATE_FIELD, "int"],
      [GEN_STATUS_FIELD, "int"],
      [GEN_VALUE_FIELD, yields],
      ...slots.map((slot) => [slot.name, slot.declaredType] as const),
    ]),
  );
}

import { getPayload } from "../core/value/index.js";
import type { TaggedValue } from "../core/value/index.js";
import type { GCObject } from "./incremental-marker.js";

type WriteBarrierGC = {
  rememberedSet: { record(holder: GCObject): void };
  isIncrementalMarkingActive(): boolean;
  incrementalWriteBarrier(holder: GCObject, newRef: GCObject): void;
};

let _gc: WriteBarrierGC | null = null;

export function bindWriteBarrierGC(gc: WriteBarrierGC | null): void {
  _gc = gc;
}

export function storeBarrier(
  holder: GCObject | null | undefined,
  newRef: GCObject | null | undefined,
): void {
  if (!_gc || !holder || !holder.gcHeader) return;
  if (!newRef || !newRef.gcHeader) return;

  if (
    holder.gcHeader.generation === "old" &&
    newRef.gcHeader.generation === "young"
  ) {
    _gc.rememberedSet.record(holder);
  }

  if (_gc.isIncrementalMarkingActive()) {
    _gc.incrementalWriteBarrier(holder, newRef);
  }
}

export function storeBarrierForTaggedValue(
  holder: GCObject | null | undefined,
  taggedValue: TaggedValue,
): void {
  if (!_gc || !holder || !holder.gcHeader) return;
  const innerObj = getPayload(taggedValue) as GCObject | null | undefined;
  if (!innerObj || typeof innerObj !== "object" || !innerObj.gcHeader) return;
  storeBarrier(holder, innerObj);
}

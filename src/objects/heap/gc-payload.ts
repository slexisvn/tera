import type { HeapPayload } from "../../core/value/index.js";
import type { GCObject } from "../../gc/incremental-marker.js";

/**
 * Narrows a heap payload to a GC-managed object, or returns null.
 * A payload qualifies when it is a non-null object carrying a truthy `gcHeader`.
 */
export function payloadGCObject(payload: HeapPayload): GCObject | null {
  return payload && typeof payload === "object" && "gcHeader" in payload && payload.gcHeader
    ? payload
    : null;
}

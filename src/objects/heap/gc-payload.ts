import type { HeapPayload } from "../../core/value/index.js";
import type { GCObject } from "../../gc/incremental-marker.js";

export function payloadGCObject(payload: HeapPayload): GCObject | null {
  return payload && typeof payload === "object" && "gcHeader" in payload && payload.gcHeader
    ? payload
    : null;
}

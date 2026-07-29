import { createJSObject } from "../objects/heap/factory.js";
import { mkObject, mkUndefined } from "../core/value/index.js";
import type { TaggedValue } from "../core/value/index.js";
import { tracer } from "../core/tracing/index.js";
import type { JSObject } from "../objects/heap/js-object.js";
import type { FrameValue, VirtualAllocation } from "./frame-state.js";

type ValueNode = {
  id?: number;
  type?: string;
  props?: { value?: TaggedValue };
};

type VirtualAllocationState = VirtualAllocation;

type SunkAllocationCarrier = {
  sunkAllocations?: Map<number, VirtualAllocationState> | null;
};

export function withMaterializedAllocations(
  frameState: SunkAllocationCarrier | null | undefined,
  runtimeValues: Map<number, TaggedValue> | null | undefined,
): Map<number, TaggedValue> | null | undefined {
  const sunk = frameState?.sunkAllocations;
  if (!sunk || sunk.size === 0) return runtimeValues;
  const resolved = new Map(runtimeValues ?? []);
  for (const [id, value] of new ObjectMaterializer().materialize(sunk, resolved)) {
    resolved.set(id, value);
  }
  return resolved;
}

export class ObjectMaterializer {
  materialize(
    sunkAllocations: Map<number, VirtualAllocationState> | null | undefined,
    runtimeValues?: Map<number, TaggedValue>,
  ): Map<number, TaggedValue> {
    if (!sunkAllocations || sunkAllocations.size === 0) return new Map();

    const materialized = new Map<number, TaggedValue>();

    for (const [allocId, virtualState] of sunkAllocations) {
      const obj: JSObject = createJSObject();

      if (virtualState.props) {
        for (const [propName, valueNode] of virtualState.props) {
          const val = this._resolveValue(
            valueNode,
            runtimeValues,
            materialized,
          );
          obj.setProperty(propName, val);
        }
      }

      if (virtualState.fields) {
        for (const [offset, valueNode] of virtualState.fields) {
          const val = this._resolveValue(
            valueNode,
            runtimeValues,
            materialized,
          );
          while (obj.slots.length <= offset) {
            obj.slots.push(undefined);
          }
          obj.slots[offset] = val;
        }
      }

      materialized.set(allocId, mkObject(obj));
      tracer.log("deopt", `Materialized sunk allocation v${allocId}`);
    }

    return materialized;
  }

  _resolveValue(
    rawValue: FrameValue | null | undefined,
    runtimeValues: Map<number, TaggedValue> | undefined,
    materialized: Map<number, TaggedValue>,
  ): TaggedValue {
    const valueNode = rawValue as ValueNode | TaggedValue | null | undefined;
    if (valueNode === null || valueNode === undefined) {
      return mkUndefined();
    }

    if (typeof valueNode === "number") {
      return valueNode;
    }

    if (typeof valueNode === "object" && valueNode.id !== undefined) {
      const id = valueNode.id;
      if (materialized.has(id)) {
        return materialized.get(id)!;
      }

      if (runtimeValues && runtimeValues.has(id)) {
        return runtimeValues.get(id)!;
      }

      if (valueNode.type === "Constant" && valueNode.props) {
        return valueNode.props.value !== undefined
          ? valueNode.props.value
          : mkUndefined();
      }
    }

    return mkUndefined();
  }
}

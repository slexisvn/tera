import { createJSObject } from "../objects/heap/factory.js";
import { mkObject, mkUndefined } from "../core/value/index.js";
import type { TaggedValue } from "../core/value/index.js";
import { tracer } from "../core/tracing/index.js";
import type { JSObject } from "../objects/heap/js-object.js";

type ValueNode = {
  id?: number;
  type?: string;
  props?: { value?: TaggedValue };
};

type VirtualAllocationState = {
  props?: Iterable<[string, ValueNode | TaggedValue | null | undefined]>;
  fields?: Iterable<[number, ValueNode | TaggedValue | null | undefined]>;
};

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
    valueNode: ValueNode | TaggedValue | null | undefined,
    runtimeValues: Map<number, TaggedValue> | undefined,
    materialized: Map<number, TaggedValue>,
  ): TaggedValue {
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

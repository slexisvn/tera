import { describe, expect, it } from "vitest";
import {
  markReachableHeapIds,
  collectLiveHeapIds,
  enumerateRoots,
} from "../../src/gc/roots.js";
import {
  mkDouble,
  mkObject,
  getHeapId,
  getPayload,
} from "../../src/core/value/index.js";
import { JSObject } from "../../src/objects/heap/js-object.js";

const emptyInterpreter = () => ({
  activeFrames: [],
  baselineFrames: [],
  transientRoots: [],
});

describe("values held only by a transient root stay reachable", () => {
  it("marks a transient root as live", () => {
    const interp = emptyInterpreter();
    const value = mkDouble(1.0000000001);
    const id = getHeapId(value);
    expect(id).toBeGreaterThan(0);

    expect(markReachableHeapIds(interp, null, null).has(id)).toBe(false);

    interp.transientRoots.push(value);
    expect(markReachableHeapIds(interp, null, null).has(id)).toBe(true);
  });

  it("tracks a transient root in the live heap-id set", () => {
    const interp = emptyInterpreter();
    const value = mkDouble(2.0000000002);
    const id = getHeapId(value);

    expect(collectLiveHeapIds(interp, null).has(id)).toBe(false);

    interp.transientRoots.push(value);
    expect(collectLiveHeapIds(interp, null).has(id)).toBe(true);
  });

  it("reports a transient root as a GC root object", () => {
    const interp = emptyInterpreter();
    const obj = new JSObject();
    obj.gcHeader = {
      age: 0,
      marked: false,
      forwarding: null,
      generation: "young",
      youngIndex: -1,
      oldGenIndex: -1,
      color: 0,
    };
    const value = mkObject(obj);

    expect(enumerateRoots(interp, null, null)).toHaveLength(0);

    interp.transientRoots.push(value);
    expect(enumerateRoots(interp, null, null)).toContain(getPayload(value));
  });

  it("follows a transient root transitively into its slots", () => {
    const interp = emptyInterpreter();
    const inner = mkDouble(3.0000000003);
    const innerId = getHeapId(inner);
    const outer = new JSObject();
    outer.slots = [inner];
    const value = mkObject(outer);

    expect(markReachableHeapIds(interp, null, null).has(innerId)).toBe(false);

    interp.transientRoots.push(value);
    expect(markReachableHeapIds(interp, null, null).has(innerId)).toBe(true);
  });

  it("drops the root again once it is popped", () => {
    const interp = emptyInterpreter();
    const value = mkDouble(4.0000000004);
    const id = getHeapId(value);

    interp.transientRoots.push(value);
    expect(markReachableHeapIds(interp, null, null).has(id)).toBe(true);

    interp.transientRoots.pop();
    expect(markReachableHeapIds(interp, null, null).has(id)).toBe(false);
  });
});

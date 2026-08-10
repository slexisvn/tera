import { describe, it, expect, beforeEach } from "vitest";
import {
  DependencyRegistry,
  dependencyKey,
  DEP_MAP,
  DEP_ELEMENTS_KIND,
  DEP_CALL_TARGET,
  DEP_PROTO_VALIDITY,
} from "../../src/deopt/dependencies.js";

const optimized = (name) => ({ name, optimizedCode: true, optimizedDependencies: [] });

const recordingMarker = () => ({
  calls: [],
  markForDeopt(fn, reason, dep) {
    this.calls.push({ fn, reason, dep });
  },
});

describe("dependencyKey", () => {
  it("formats kind:id without version", () => {
    expect(dependencyKey(DEP_MAP, 42)).toBe("map:42");
  });

  it("formats kind:id:version with version", () => {
    expect(dependencyKey(DEP_MAP, 42, 3)).toBe("map:42:3");
  });

  it("treats null/undefined version as no version", () => {
    expect(dependencyKey(DEP_MAP, 1, null)).toBe("map:1");
    expect(dependencyKey(DEP_MAP, 1, undefined)).toBe("map:1");
  });

  it("treats numeric version 0 as present", () => {
    expect(dependencyKey(DEP_MAP, 1, 0)).toBe("map:1:0");
  });

  it("accepts a string id", () => {
    expect(dependencyKey(DEP_CALL_TARGET, "myFunc")).toBe("call-target:myFunc");
  });
});

describe("DependencyRegistry", () => {
  let reg;
  let fn1;
  let fn2;

  beforeEach(() => {
    reg = new DependencyRegistry();
    fn1 = optimized("fn1");
    fn2 = optimized("fn2");
  });

  describe("register and getSummary", () => {
    it("returns normalized deps", () => {
      reg.register(fn1, [
        { kind: DEP_MAP, id: 10 },
        { kind: DEP_ELEMENTS_KIND, id: 20 },
      ]);
      const summary = reg.getSummary(fn1);
      expect(summary).toHaveLength(2);
      expect(summary[0].kind).toBe(DEP_MAP);
      expect(summary[0].id).toBe(10);
    });

    it("deduplicates the same dependency", () => {
      reg.register(fn1, [
        { kind: DEP_MAP, id: 10 },
        { kind: DEP_MAP, id: 10 },
        { kind: DEP_MAP, id: 10 },
      ]);
      expect(reg.getSummary(fn1)).toHaveLength(1);
    });

    it("normalizes a missing version to null and preserves a supplied one", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 1 }]);
      reg.register(fn2, [{ kind: DEP_MAP, id: 1, version: 7 }]);
      expect(reg.getSummary(fn1)[0].version).toBe(null);
      expect(reg.getSummary(fn2)[0].version).toBe(7);
    });

    it("drops entries with no kind", () => {
      reg.register(fn1, [null, { kind: DEP_MAP, id: 1 }, { notKind: true }]);
      const summary = reg.getSummary(fn1);
      expect(summary).toHaveLength(1);
      expect(summary[0].kind).toBe(DEP_MAP);
    });

    it("accepts a null dependency list", () => {
      reg.register(fn1, null);
      expect(reg.getSummary(fn1)).toEqual([]);
    });

    it("returns an empty summary for an unregistered function", () => {
      expect(reg.getSummary(optimized("unknown"))).toEqual([]);
    });

    it("removes every old dependency before adding the new ones", () => {
      reg.register(fn1, [
        { kind: DEP_MAP, id: 1 },
        { kind: DEP_CALL_TARGET, id: 2 },
      ]);
      reg.register(fn1, [{ kind: DEP_ELEMENTS_KIND, id: 3 }]);

      expect(reg.invalidate(DEP_MAP, 1)).toBe(0);
      expect(reg.invalidate(DEP_CALL_TARGET, 2)).toBe(0);
      expect(reg.invalidate(DEP_ELEMENTS_KIND, 3)).toBe(1);
    });
  });

  describe("invalidate", () => {
    it("marks the function with the full deopt reason, kind and id", () => {
      reg.register(fn1, [{ kind: DEP_PROTO_VALIDITY, id: 7 }]);
      expect(reg.invalidate(DEP_PROTO_VALIDITY, 7, null, "proto-changed")).toBe(1);
      expect(fn1.pendingDependencyDeopt).toEqual(
        expect.objectContaining({ reason: "proto-changed", kind: DEP_PROTO_VALIDITY, id: 7 }),
      );
    });

    it("counts the function but does not mark it when optimizedCode is null", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
      fn1.optimizedCode = null;
      expect(reg.invalidate(DEP_MAP, 10)).toBe(1);
      expect(fn1.pendingDependencyDeopt).toBeUndefined();
    });

    it("without a version does not match versioned-only registrations", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 10, version: 5 }]);
      expect(reg.invalidate(DEP_MAP, 10, null, "map-changed")).toBe(0);
    });

    it("with a version matches both versioned and unversioned registrations", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
      reg.register(fn2, [{ kind: DEP_MAP, id: 10, version: 3 }]);
      expect(reg.invalidate(DEP_MAP, 10, 3, "map-changed")).toBe(2);
    });

    it("invalidates every function sharing a dependency", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
      reg.register(fn2, [{ kind: DEP_MAP, id: 10 }]);
      expect(reg.invalidate(DEP_MAP, 10)).toBe(2);
    });

    it("routes to the lazy marker once bound", () => {
      const marker = recordingMarker();
      reg.bindLazyMarker(marker);
      reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
      reg.invalidate(DEP_MAP, 10, null, "map-changed");
      expect(marker.calls).toHaveLength(1);
      expect(marker.calls[0].fn).toBe(fn1);
      expect(marker.calls[0].reason).toBe("map-changed");
    });

    it("marks a function once when it matches under both versioned and unversioned keys", () => {
      const marker = recordingMarker();
      reg.bindLazyMarker(marker);
      reg.register(fn1, [
        { kind: DEP_MAP, id: 10 },
        { kind: DEP_MAP, id: 10, version: 3 },
      ]);
      reg.invalidate(DEP_MAP, 10, 3, "changed");
      expect(marker.calls).toHaveLength(1);
    });
  });

  describe("unregister and clear", () => {
    it("removes the function and empties its dependency list", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
      reg.unregister(fn1);
      expect(reg.invalidate(DEP_MAP, 10)).toBe(0);
      expect(fn1.optimizedDependencies).toEqual([]);
    });

    it("leaves other functions sharing the dependency registered", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
      reg.register(fn2, [{ kind: DEP_MAP, id: 10 }]);
      reg.unregister(fn1);
      expect(reg.invalidate(DEP_MAP, 10)).toBe(1);
    });

    it("clear empties all registrations", () => {
      reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
      reg.register(fn2, [{ kind: DEP_MAP, id: 20 }]);
      reg.clear();
      expect(reg.invalidate(DEP_MAP, 10)).toBe(0);
      expect(reg.invalidate(DEP_MAP, 20)).toBe(0);
    });
  });
});

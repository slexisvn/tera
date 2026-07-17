import { describe, it, expect, beforeEach } from "vitest";
import {
  DependencyRegistry,
  dependencyKey,
  DEP_MAP,
  DEP_ELEMENTS_KIND,
  DEP_CALL_TARGET,
  DEP_PROTO_VALIDITY,
} from "../../src/deopt/dependencies.js";

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
});

describe("DependencyRegistry", () => {
  let reg;
  let fn1;
  let fn2;

  beforeEach(() => {
    reg = new DependencyRegistry();
    fn1 = { name: "fn1", optimizedCode: true, optimizedDependencies: [] };
    fn2 = { name: "fn2", optimizedCode: true, optimizedDependencies: [] };
  });

  it("register and getSummary returns normalized deps", () => {
    reg.register(fn1, [
      { kind: DEP_MAP, id: 10 },
      { kind: DEP_ELEMENTS_KIND, id: 20 },
    ]);
    const summary = reg.getSummary(fn1);
    expect(summary).toHaveLength(2);
    expect(summary[0].kind).toBe(DEP_MAP);
    expect(summary[0].id).toBe(10);
  });

  it("register deduplicates same dependency", () => {
    reg.register(fn1, [
      { kind: DEP_MAP, id: 10 },
      { kind: DEP_MAP, id: 10 },
      { kind: DEP_MAP, id: 10 },
    ]);
    const summary = reg.getSummary(fn1);
    expect(summary).toHaveLength(1);
  });

  it("invalidate marks functions with pendingDependencyDeopt", () => {
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    const affected = reg.invalidate(DEP_MAP, 10, null, "map-changed");
    expect(affected).toBe(1);
    expect(fn1.pendingDependencyDeopt).toBeDefined();
    expect(fn1.pendingDependencyDeopt.reason).toBe("map-changed");
  });

  it("invalidate counts function in affected but does not mark deopt when optimizedCode is null", () => {
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    fn1.optimizedCode = null;
    const affected = reg.invalidate(DEP_MAP, 10);
    expect(affected).toBe(1);
    expect(fn1.pendingDependencyDeopt).toBeUndefined();
  });

  it("invalidate with version matches both versioned and unversioned keys", () => {
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.register(fn2, [{ kind: DEP_MAP, id: 10, version: 3 }]);
    const affected = reg.invalidate(DEP_MAP, 10, 3, "map-changed");
    expect(affected).toBeGreaterThanOrEqual(1);
  });

  it("invalidate uses lazyMarker when bound", () => {
    const marker = {
      calls: [],
      markForDeopt(fn, reason, dep) { this.calls.push({ fn, reason, dep }); },
    };
    reg.bindLazyMarker(marker);
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.invalidate(DEP_MAP, 10, null, "map-changed");
    expect(marker.calls).toHaveLength(1);
    expect(marker.calls[0].fn).toBe(fn1);
    expect(marker.calls[0].reason).toBe("map-changed");
  });

  it("unregister removes function from registry", () => {
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.unregister(fn1);
    const affected = reg.invalidate(DEP_MAP, 10);
    expect(affected).toBe(0);
    expect(fn1.optimizedDependencies).toEqual([]);
  });

  it("re-register clears old dependencies first", () => {
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.register(fn1, [{ kind: DEP_CALL_TARGET, id: 20 }]);
    const affected1 = reg.invalidate(DEP_MAP, 10);
    expect(affected1).toBe(0);
    const affected2 = reg.invalidate(DEP_CALL_TARGET, 20);
    expect(affected2).toBe(1);
  });

  it("clear empties all registrations", () => {
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.register(fn2, [{ kind: DEP_MAP, id: 20 }]);
    reg.clear();
    expect(reg.invalidate(DEP_MAP, 10)).toBe(0);
    expect(reg.invalidate(DEP_MAP, 20)).toBe(0);
  });

  it("multiple functions on same dependency all get invalidated", () => {
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.register(fn2, [{ kind: DEP_MAP, id: 10 }]);
    const affected = reg.invalidate(DEP_MAP, 10);
    expect(affected).toBe(2);
  });

  it("getSummary returns empty for unregistered function", () => {
    const unknown = { name: "unknown", optimizedDependencies: [] };
    expect(reg.getSummary(unknown)).toEqual([]);
  });

  it("normalizes away deps with no kind", () => {
    reg.register(fn1, [null, { kind: DEP_MAP, id: 1 }, { notKind: true }]);
    const summary = reg.getSummary(fn1);
    expect(summary).toHaveLength(1);
    expect(summary[0].kind).toBe(DEP_MAP);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  DependencyRegistry,
  dependencyKey,
  DEP_MAP,
  DEP_CALL_TARGET,
  DEP_PROTO_VALIDITY,
  DEP_ELEMENTS_KIND,
} from "../../src/deopt/dependencies.js";

describe("DependencyRegistry invalidation edge cases", () => {
  let reg;

  beforeEach(() => {
    reg = new DependencyRegistry();
  });

  it("invalidate without version does not match versioned-only registrations", () => {
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, [{ kind: DEP_MAP, id: 10, version: 5 }]);
    const affected = reg.invalidate(DEP_MAP, 10, null, "map-changed");
    expect(affected).toBe(0);
  });

  it("invalidate with version matches both versioned and unversioned registrations", () => {
    const fn1 = { name: "fn1", optimizedCode: true, optimizedDependencies: [] };
    const fn2 = { name: "fn2", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.register(fn2, [{ kind: DEP_MAP, id: 10, version: 3 }]);
    const affected = reg.invalidate(DEP_MAP, 10, 3, "changed");
    expect(affected).toBe(2);
  });

  it("invalidate deduplicates functions registered under both versioned and unversioned keys", () => {
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, [
      { kind: DEP_MAP, id: 10 },
      { kind: DEP_MAP, id: 10, version: 3 },
    ]);
    const marker = {
      calls: [],
      markForDeopt(f, reason, dep) { this.calls.push(f); },
    };
    reg.bindLazyMarker(marker);
    reg.invalidate(DEP_MAP, 10, 3, "changed");
    expect(marker.calls).toHaveLength(1);
  });

  it("invalidate sets pendingDependencyDeopt with full info when no lazyMarker", () => {
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, [{ kind: DEP_PROTO_VALIDITY, id: 7 }]);
    reg.invalidate(DEP_PROTO_VALIDITY, 7, null, "proto-changed");
    expect(fn.pendingDependencyDeopt.reason).toBe("proto-changed");
    expect(fn.pendingDependencyDeopt.kind).toBe(DEP_PROTO_VALIDITY);
    expect(fn.pendingDependencyDeopt.id).toBe(7);
  });
});

describe("DependencyRegistry unregister cleans up byKey sets", () => {
  it("removes empty sets from byKey after unregister", () => {
    const reg = new DependencyRegistry();
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, [{ kind: DEP_MAP, id: 10 }]);
    reg.unregister(fn);
    expect(reg.invalidate(DEP_MAP, 10)).toBe(0);
  });

  it("does not affect other functions sharing the same dependency", () => {
    const reg = new DependencyRegistry();
    const fn1 = { name: "fn1", optimizedCode: true, optimizedDependencies: [] };
    const fn2 = { name: "fn2", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn1, [{ kind: DEP_MAP, id: 10 }]);
    reg.register(fn2, [{ kind: DEP_MAP, id: 10 }]);
    reg.unregister(fn1);
    const affected = reg.invalidate(DEP_MAP, 10);
    expect(affected).toBe(1);
  });
});

describe("DependencyRegistry register replaces old deps atomically", () => {
  it("old deps are fully removed before new ones are added", () => {
    const reg = new DependencyRegistry();
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, [
      { kind: DEP_MAP, id: 1 },
      { kind: DEP_CALL_TARGET, id: 2 },
    ]);
    reg.register(fn, [{ kind: DEP_ELEMENTS_KIND, id: 3 }]);

    expect(reg.invalidate(DEP_MAP, 1)).toBe(0);
    expect(reg.invalidate(DEP_CALL_TARGET, 2)).toBe(0);
    expect(reg.invalidate(DEP_ELEMENTS_KIND, 3)).toBe(1);
  });
});

describe("normalizeDependencies via register", () => {
  it("normalizes version to null when not provided", () => {
    const reg = new DependencyRegistry();
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, [{ kind: DEP_MAP, id: 1 }]);
    const summary = reg.getSummary(fn);
    expect(summary[0].version).toBe(null);
  });

  it("preserves version when provided", () => {
    const reg = new DependencyRegistry();
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, [{ kind: DEP_MAP, id: 1, version: 7 }]);
    const summary = reg.getSummary(fn);
    expect(summary[0].version).toBe(7);
  });

  it("handles empty/null dependencies input", () => {
    const reg = new DependencyRegistry();
    const fn = { name: "fn", optimizedCode: true, optimizedDependencies: [] };
    reg.register(fn, null);
    expect(reg.getSummary(fn)).toEqual([]);
  });
});

describe("dependencyKey formatting", () => {
  it("handles numeric version 0 as present", () => {
    expect(dependencyKey(DEP_MAP, 1, 0)).toBe("map:1:0");
  });

  it("handles string id", () => {
    expect(dependencyKey(DEP_CALL_TARGET, "myFunc")).toBe("call-target:myFunc");
  });
});

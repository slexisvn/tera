import { describe, it, expect, beforeEach } from "vitest";
import {
  LoadFieldHandler,
  StoreFieldHandler,
  TransitionStoreHandler,
  MissingPropertyHandler,
  ProtoLoadFieldHandler,
  MegamorphicCache,
  CallHandler,
  LoadElementHandler,
  StoreElementHandler,
  PropertyLoadIC,
  PropertyStoreIC,
  ElementLoadIC,
  ElementStoreIC,
  CallIC,
  InlineCache,
  InlineCacheManager,
  IC_UNINITIALIZED,
  IC_MONOMORPHIC,
  IC_POLYMORPHIC,
  IC_MEGAMORPHIC,
  globalMegamorphicCache,
} from "../../src/feedback/ic/index.js";

function makeObj(hcId, version = 1, props = {}) {
  const propMap = new Map(Object.entries(props));
  const slots = Object.values(props);
  return {
    hiddenClass: {
      id: hcId,
      version,
      isDeprecated: false,
      lookupProperty(name) {
        const keys = Object.keys(props);
        const idx = keys.indexOf(name);
        if (idx === -1) return null;
        return { offset: idx };
      },
    },
    prototype: null,
    slots,
    getPropertyByOffset(offset) { return slots[offset]; },
    setPropertyByOffset(offset, value) { slots[offset] = value; },
    setProperty(name, value) {
      const keys = Object.keys(props);
      const idx = keys.indexOf(name);
      if (idx >= 0) slots[idx] = value;
      else {
        props[name] = value;
        slots.push(value);
      }
    },
    lookupPrototypeChain() { return { found: false }; },
    migrateInstance() {},
  };
}

function makeArrayObj(elementsKind, elements) {
  return {
    getElementsKind() { return elementsKind; },
    getIndex(i) { return elements[i]; },
    setIndex(i, v) { elements[i] = v; },
    elements,
  };
}

describe("LoadFieldHandler", () => {
  it("matches when hcId, version match and not deprecated", () => {
    const h = new LoadFieldHandler(1, 1, 0, "x");
    const obj = makeObj(1, 1, { x: 42 });
    expect(h.matches(obj)).toBe(true);
  });

  it("misses on different hcId", () => {
    const h = new LoadFieldHandler(1, 1, 0, "x");
    expect(h.matches(makeObj(2, 1, { x: 42 }))).toBe(false);
  });

  it("misses on different version", () => {
    const h = new LoadFieldHandler(1, 1, 0, "x");
    expect(h.matches(makeObj(1, 2, { x: 42 }))).toBe(false);
  });

  it("misses on deprecated", () => {
    const h = new LoadFieldHandler(1, 1, 0, "x");
    const obj = makeObj(1, 1, { x: 42 });
    obj.hiddenClass.isDeprecated = true;
    expect(h.matches(obj)).toBe(false);
  });

  it("executes by reading property at offset", () => {
    const h = new LoadFieldHandler(1, 1, 0, "x");
    expect(h.execute(makeObj(1, 1, { x: 99 }))).toBe(99);
  });
});

describe("StoreFieldHandler", () => {
  it("executes by writing property at offset", () => {
    const h = new StoreFieldHandler(1, 1, 0, "x");
    const obj = makeObj(1, 1, { x: 0 });
    h.execute(obj, 777);
    expect(obj.slots[0]).toBe(777);
  });
});

describe("TransitionStoreHandler", () => {
  it("matches on old hidden class id and version", () => {
    const h = new TransitionStoreHandler(1, 1, 2, 0, "y");
    expect(h.matches(makeObj(1, 1))).toBe(true);
    expect(h.matches(makeObj(2, 1))).toBe(false);
  });

  it("executes via setProperty", () => {
    const h = new TransitionStoreHandler(1, 1, 2, 0, "y");
    const obj = makeObj(1, 1, { x: 10 });
    h.execute(obj, 20);
    expect(obj.slots).toContain(20);
  });
});

describe("MissingPropertyHandler", () => {
  it("always returns undefined", () => {
    const h = new MissingPropertyHandler(1, 1, "z");
    expect(h.execute(makeObj(1, 1))).toBeUndefined();
    expect(h.offset).toBe(-1);
  });
});

describe("ProtoLoadFieldHandler", () => {
  it("matches when receiver and proto pass all checks", () => {
    const proto = {
      hiddenClass: { id: 10, version: 1, isDeprecated: false },
      getPrototypeValidityVersion() { return 5; },
      getPropertyByOffset(offset) { return [100, 200][offset]; },
    };
    const h = new ProtoLoadFieldHandler(1, 1, 10, 1, 5, 0, proto, "method", 1);
    const receiver = makeObj(1, 1);
    expect(h.matches(receiver)).toBe(true);
    expect(h.execute(receiver)).toBe(100);
  });

  it("misses when proto validity version changes", () => {
    const proto = {
      hiddenClass: { id: 10, version: 1, isDeprecated: false },
      getPrototypeValidityVersion() { return 99; },
    };
    const h = new ProtoLoadFieldHandler(1, 1, 10, 1, 5, 0, proto, "method", 1);
    expect(h.matches(makeObj(1, 1))).toBe(false);
  });

  it("misses when proto deprecated", () => {
    const proto = {
      hiddenClass: { id: 10, version: 1, isDeprecated: true },
      getPrototypeValidityVersion() { return 5; },
    };
    const h = new ProtoLoadFieldHandler(1, 1, 10, 1, 5, 0, proto, "method", 1);
    expect(h.matches(makeObj(1, 1))).toBe(false);
  });
});

describe("MegamorphicCache", () => {
  let cache;
  beforeEach(() => { cache = new MegamorphicCache(); });

  it("stores and retrieves load handlers", () => {
    const h = new LoadFieldHandler(1, 1, 0, "x");
    cache.setLoad(1, "x", h);
    expect(cache.getLoad(1, "x")).toBe(h);
    expect(cache.getLoad(1, "y")).toBeUndefined();
  });

  it("deletes load handlers", () => {
    cache.setLoad(1, "x", {});
    cache.deleteLoad(1, "x");
    expect(cache.getLoad(1, "x")).toBeUndefined();
  });

  it("stores and retrieves store handlers", () => {
    const h = new StoreFieldHandler(1, 1, 0, "x");
    cache.setStore(1, "x", h);
    expect(cache.getStore(1, "x")).toBe(h);
  });

  it("stores and retrieves element handlers", () => {
    const lh = new LoadElementHandler("PACKED_SMI");
    const sh = new StoreElementHandler("PACKED_DOUBLE");
    cache.setElementLoad("PACKED_SMI", lh);
    cache.setElementStore("PACKED_DOUBLE", sh);
    expect(cache.getElementLoad("PACKED_SMI")).toBe(lh);
    expect(cache.getElementStore("PACKED_DOUBLE")).toBe(sh);
  });
});

describe("LoadElementHandler", () => {
  it("reads element by index", () => {
    const h = new LoadElementHandler("PACKED_SMI");
    const arr = makeArrayObj("PACKED_SMI", [10, 20, 30]);
    expect(h.execute(arr, 1)).toBe(20);
  });
});

describe("StoreElementHandler", () => {
  it("writes element by index", () => {
    const h = new StoreElementHandler("PACKED_SMI");
    const arr = makeArrayObj("PACKED_SMI", [10, 20, 30]);
    h.execute(arr, 1, 99);
    expect(arr.elements[1]).toBe(99);
  });
});

describe("CallHandler", () => {
  it("matches same compiled target with same argCount", () => {
    const compiled = { id: "fn1", version: 2 };
    const h = new CallHandler("fn1", 2, 3, compiled);
    const callee = { compiled };
    expect(h.matches(callee, 3)).toBe(true);
  });

  it("misses on different argCount", () => {
    const compiled = { id: "fn1", version: 2 };
    const h = new CallHandler("fn1", 2, 3, compiled);
    expect(h.matches({ compiled }, 1)).toBe(false);
  });

  it("misses on different target version", () => {
    const h = new CallHandler("fn1", 2, 3, null);
    const callee = { compiled: { id: "fn1", version: 99 } };
    expect(h.matches(callee, 3)).toBe(false);
  });

  it("matches builtin by name", () => {
    const h = new CallHandler("builtin:print", 0, 1, null);
    const callee = { name: "print" };
    expect(h.matches(callee, 1)).toBe(true);
  });
});

describe("PropertyLoadIC", () => {
  it("transitions uninitialized -> monomorphic -> polymorphic on different objects", () => {
    const ic = new PropertyLoadIC("site1");
    const obj1 = makeObj(1, 1, { x: 10 });
    const obj2 = makeObj(2, 1, { x: 20 });
    ic.lookup(obj1, "x");
    expect(ic.state).toBe(IC_MONOMORPHIC);
    ic.lookup(obj2, "x");
    expect(ic.state).toBe(IC_POLYMORPHIC);
  });

  it("hits on monomorphic fast path", () => {
    const ic = new PropertyLoadIC("site2");
    const obj = makeObj(1, 1, { x: 42 });
    ic.lookup(obj, "x");
    const result = ic.lookup(obj, "x");
    expect(result.hit).toBe(true);
    expect(result.value).toBe(42);
    expect(ic.hitCount).toBe(1);
  });

  it("hits on polymorphic path", () => {
    const ic = new PropertyLoadIC("site3");
    const obj1 = makeObj(1, 1, { x: 10 });
    const obj2 = makeObj(2, 1, { x: 20 });
    ic.lookup(obj1, "x");
    ic.lookup(obj2, "x");
    const r1 = ic.lookup(obj1, "x");
    const r2 = ic.lookup(obj2, "x");
    expect(r1.value).toBe(10);
    expect(r2.value).toBe(20);
  });

  it("transitions to megamorphic after 8 unique classes", () => {
    const ic = new PropertyLoadIC("site4");
    for (let i = 1; i <= 9; i++) ic.lookup(makeObj(i, 1, { x: i }), "x");
    expect(ic.state).toBe(IC_MEGAMORPHIC);
    expect(ic.entries).toBeNull();
  });

  it("returns missing property as hit:false, value:undefined", () => {
    const ic = new PropertyLoadIC("site5");
    const obj = makeObj(1, 1, {});
    const result = ic.lookup(obj, "missing");
    expect(result.hit).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it("becomes JIT candidate after 100 monomorphic hits", () => {
    const ic = new PropertyLoadIC("site6");
    const obj = makeObj(1, 1, { x: 1 });
    for (let i = 0; i < 102; i++) ic.lookup(obj, "x");
    expect(ic.jitCandidate).toBe(true);
  });

  it("invalidate resets state to uninitialized", () => {
    const ic = new PropertyLoadIC("site7");
    ic.lookup(makeObj(1, 1, { x: 1 }), "x");
    ic.invalidate();
    expect(ic.state).toBe(IC_UNINITIALIZED);
    expect(ic.entries).toHaveLength(0);
    expect(ic.jitCandidate).toBe(false);
  });

  it("getSortedHandlers orders by hit count descending", () => {
    const ic = new PropertyLoadIC("site8");
    const obj1 = makeObj(1, 1, { x: 10 });
    const obj2 = makeObj(2, 1, { x: 20 });
    ic.lookup(obj1, "x");
    ic.lookup(obj2, "x");
    for (let i = 0; i < 5; i++) ic.lookup(obj2, "x");
    const sorted = ic.getSortedHandlers();
    expect(sorted[0].hiddenClassId).toBe(2);
  });

  it("getDominantHandler returns entry >=80% hits", () => {
    const ic = new PropertyLoadIC("site9");
    const obj1 = makeObj(1, 1, { x: 10 });
    const obj2 = makeObj(2, 1, { x: 20 });
    ic.lookup(obj1, "x");
    ic.lookup(obj2, "x");
    for (let i = 0; i < 20; i++) ic.lookup(obj1, "x");
    const dominant = ic.getDominantHandler();
    expect(dominant).not.toBeNull();
    expect(dominant.hiddenClassId).toBe(1);
  });

  it("getDominantHandler returns null when evenly split", () => {
    const ic = new PropertyLoadIC("site10");
    const obj1 = makeObj(1, 1, { x: 10 });
    const obj2 = makeObj(2, 1, { x: 20 });
    ic.lookup(obj1, "x");
    ic.lookup(obj2, "x");
    for (let i = 0; i < 5; i++) {
      ic.lookup(obj1, "x");
      ic.lookup(obj2, "x");
    }
    expect(ic.getDominantHandler()).toBeNull();
  });

  it("handles deprecated map by invalidating", () => {
    const ic = new PropertyLoadIC("site11");
    const obj = makeObj(1, 1, { x: 1 });
    ic.lookup(obj, "x");
    expect(ic.state).toBe(IC_MONOMORPHIC);
    obj.hiddenClass.isDeprecated = true;
    ic.lookup(obj, "x");
    expect(ic.missCount).toBeGreaterThan(0);
  });

  it("getPolymorphicProfile returns ratio per entry", () => {
    const ic = new PropertyLoadIC("site12");
    const obj1 = makeObj(1, 1, { x: 10 });
    const obj2 = makeObj(2, 1, { x: 20 });
    ic.lookup(obj1, "x");
    ic.lookup(obj2, "x");
    for (let i = 0; i < 3; i++) ic.lookup(obj1, "x");
    ic.lookup(obj2, "x");
    const profile = ic.getPolymorphicProfile();
    expect(profile).toHaveLength(2);
    const total = profile.reduce((s, p) => s + p.hitCount, 0);
    expect(total).toBe(ic.hitCount);
  });
});

describe("PropertyStoreIC", () => {
  it("transitions through IC states on store", () => {
    const ic = new PropertyStoreIC("s1");
    const obj1 = makeObj(1, 1, { x: 0 });
    const obj2 = makeObj(2, 1, { x: 0 });
    ic.store(obj1, "x", 10);
    expect(ic.state).toBe(IC_MONOMORPHIC);
    ic.store(obj2, "x", 20);
    expect(ic.state).toBe(IC_POLYMORPHIC);
  });

  it("hits on monomorphic fast path and writes value", () => {
    const ic = new PropertyStoreIC("s2");
    const obj = makeObj(1, 1, { x: 0 });
    ic.store(obj, "x", 10);
    ic.store(obj, "x", 20);
    expect(ic.hitCount).toBe(1);
    expect(obj.slots[0]).toBe(20);
  });

  it("becomes JIT candidate after 100 monomorphic hits", () => {
    const ic = new PropertyStoreIC("s3");
    const obj = makeObj(1, 1, { x: 0 });
    for (let i = 0; i < 102; i++) ic.store(obj, "x", i);
    expect(ic.jitCandidate).toBe(true);
  });
});

describe("ElementLoadIC", () => {
  it("transitions through states on different element kinds", () => {
    const ic = new ElementLoadIC("el1");
    const arr1 = makeArrayObj("PACKED_SMI", [1, 2, 3]);
    const arr2 = makeArrayObj("PACKED_DOUBLE", [1.1, 2.2]);
    ic.lookup(arr1, 0);
    expect(ic.state).toBe(IC_MONOMORPHIC);
    ic.lookup(arr2, 0);
    expect(ic.state).toBe(IC_POLYMORPHIC);
  });

  it("hits on monomorphic path and returns value", () => {
    const ic = new ElementLoadIC("el2");
    const arr = makeArrayObj("PACKED_SMI", [10, 20, 30]);
    ic.lookup(arr, 0);
    const result = ic.lookup(arr, 1);
    expect(result.hit).toBe(true);
    expect(result.value).toBe(20);
  });

  it("transitions to megamorphic after >4 kinds", () => {
    const ic = new ElementLoadIC("el3");
    const kinds = ["PACKED_SMI", "PACKED_DOUBLE", "PACKED_ELEMENTS", "HOLEY_SMI", "HOLEY_DOUBLE"];
    for (const k of kinds) ic.lookup(makeArrayObj(k, [1]), 0);
    expect(ic.state).toBe(IC_MEGAMORPHIC);
  });

  it("getStats reports element kinds", () => {
    const ic = new ElementLoadIC("el4");
    ic.lookup(makeArrayObj("PACKED_SMI", [1]), 0);
    const stats = ic.getStats();
    expect(stats.kinds).toEqual(["PACKED_SMI"]);
    expect(stats.type).toBe("element-load");
  });
});

describe("ElementStoreIC", () => {
  it("stores value and transitions", () => {
    const ic = new ElementStoreIC("es1");
    const arr = makeArrayObj("PACKED_SMI", [1, 2, 3]);
    ic.store(arr, 1, 99);
    expect(arr.elements[1]).toBe(99);
    expect(ic.state).toBe(IC_MONOMORPHIC);
  });

  it("hits on monomorphic fast path", () => {
    const ic = new ElementStoreIC("es2");
    const arr = makeArrayObj("PACKED_SMI", [1, 2, 3]);
    ic.store(arr, 0, 10);
    ic.store(arr, 1, 20);
    expect(ic.hitCount).toBe(1);
  });
});

describe("CallIC", () => {
  it("monomorphic hit on same callee", () => {
    const ic = new CallIC("c1");
    const compiled = { id: "fn1", version: 1 };
    const callee = { compiled };
    ic.lookup(callee, 2);
    const result = ic.lookup(callee, 2);
    expect(result.hit).toBe(true);
    expect(ic.hitCount).toBe(1);
  });

  it("transitions to polymorphic on different callee", () => {
    const ic = new CallIC("c2");
    ic.lookup({ compiled: { id: "f1", version: 1 } }, 1);
    ic.lookup({ compiled: { id: "f2", version: 1 } }, 1);
    expect(ic.state).toBe(IC_POLYMORPHIC);
  });

  it("invalidate resets", () => {
    const ic = new CallIC("c3");
    ic.lookup({ compiled: { id: "f1", version: 1 } }, 1);
    ic.invalidate();
    expect(ic.state).toBe(IC_UNINITIALIZED);
  });
});

describe("InlineCache", () => {
  it("delegates to sub-ICs", () => {
    const ic = new InlineCache("unified");
    const obj = makeObj(1, 1, { x: 42 });
    ic.lookup(obj, "x");
    expect(ic.loadIC.state).toBe(IC_MONOMORPHIC);

    ic.lookupForWrite(makeObj(1, 1, { x: 0 }), "x", 10);
    expect(ic.storeIC.state).toBe(IC_MONOMORPHIC);

    const arr = makeArrayObj("PACKED_SMI", [1, 2]);
    ic.lookupElement(arr, 0);
    expect(ic.elementLoadIC.state).toBe(IC_MONOMORPHIC);

    ic.lookupElementForWrite(arr, 0, 99);
    expect(ic.elementStoreIC.state).toBe(IC_MONOMORPHIC);
  });

  it("invalidate resets all sub-ICs", () => {
    const ic = new InlineCache("u2");
    ic.lookup(makeObj(1, 1, { x: 1 }), "x");
    ic.invalidate();
    expect(ic.loadIC.state).toBe(IC_UNINITIALIZED);
    expect(ic.storeIC.state).toBe(IC_UNINITIALIZED);
    expect(ic.elementLoadIC.state).toBe(IC_UNINITIALIZED);
    expect(ic.elementStoreIC.state).toBe(IC_UNINITIALIZED);
    expect(ic.callIC.state).toBe(IC_UNINITIALIZED);
  });

  it("state getter reflects active sub-IC", () => {
    const ic = new InlineCache("u3");
    expect(ic.state).toBe(IC_UNINITIALIZED);
    ic.lookup(makeObj(1, 1, { x: 1 }), "x");
    expect(ic.state).toBe(IC_MONOMORPHIC);
  });
});

describe("InlineCacheManager", () => {
  let mgr;
  beforeEach(() => { mgr = new InlineCacheManager(); });

  it("getOrCreate returns same cache for same siteId", () => {
    const ic1 = mgr.getOrCreate("s1");
    const ic2 = mgr.getOrCreate("s1");
    expect(ic1).toBe(ic2);
  });

  it("get returns undefined for unknown site", () => {
    expect(mgr.get("nope")).toBeUndefined();
  });

  it("registerHiddenClassUsage and invalidateForHiddenClass", () => {
    const ic = mgr.getOrCreate("s1");
    ic.lookup(makeObj(1, 1, { x: 1 }), "x");
    mgr.registerHiddenClassUsage(1, "s1");
    const count = mgr.invalidateForHiddenClass(1);
    expect(count).toBe(1);
    expect(ic.loadIC.state).toBe(IC_UNINITIALIZED);
  });

  it("flush clears everything", () => {
    mgr.getOrCreate("s1");
    mgr.getOrCreate("s2");
    mgr.flush();
    expect(mgr.get("s1")).toBeUndefined();
    expect(mgr.get("s2")).toBeUndefined();
  });

  it("collectStats aggregates across caches", () => {
    const ic1 = mgr.getOrCreate("s1");
    const ic2 = mgr.getOrCreate("s2");
    ic1.lookup(makeObj(1, 1, { x: 1 }), "x");
    ic2.lookup(makeObj(2, 1, { y: 2 }), "y");
    const stats = mgr.collectStats();
    expect(stats.totalCaches).toBe(2);
    expect(stats.monomorphicLoads).toBe(2);
    expect(stats.totalMisses).toBe(2);
  });

  it("reportPolymorphism lists polymorphic/megamorphic sites", () => {
    const ic = mgr.getOrCreate("poly");
    ic.lookup(makeObj(1, 1, { x: 1 }), "x");
    ic.lookup(makeObj(2, 1, { x: 2 }), "x");
    const report = mgr.reportPolymorphism();
    expect(report).toHaveLength(1);
    expect(report[0].siteId).toBe("poly");
    expect(report[0].loadState).toBe(IC_POLYMORPHIC);
  });

  it("getJitCandidates lists JIT-ready sites", () => {
    const ic = mgr.getOrCreate("jit");
    const obj = makeObj(1, 1, { x: 1 });
    for (let i = 0; i < 102; i++) ic.lookup(obj, "x");
    const candidates = mgr.getJitCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].siteId).toBe("jit");
    expect(candidates[0].loadJit).toBe(true);
  });
});

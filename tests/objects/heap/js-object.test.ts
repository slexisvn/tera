import { describe, it, expect, beforeEach } from "vitest";
import {
  JSObject,
  AccessorPair,
  presizeInstanceSlots,
  recordConstruction,
} from "../../../src/objects/heap/js-object.js";
import {
  resetHiddenClasses,
  ROOT_HIDDEN_CLASS,
  INTEGRITY_FROZEN,
} from "../../../src/objects/maps/hidden-class.js";
import { mkSmi, mkString } from "../../../src/core/value/index.js";

beforeEach(() => {
  resetHiddenClasses();
});

describe("JSObject property storage", () => {
  it("set then get returns the value", () => {
    const obj = new JSObject();
    obj.setProperty("x", mkSmi(42));
    expect(obj.getProperty("x")).toBe(mkSmi(42));
  });

  it("setting a new property transitions the hidden class", () => {
    const obj = new JSObject();
    const hc0 = obj.hiddenClass;
    obj.setProperty("a", mkSmi(1));
    expect(obj.hiddenClass).not.toBe(hc0);
    expect(obj.hiddenClass.hasProperty("a")).toBe(true);
  });

  it("objects with same property order share hidden class", () => {
    const a = new JSObject();
    const b = new JSObject();
    a.setProperty("x", mkSmi(1));
    a.setProperty("y", mkSmi(2));
    b.setProperty("x", mkSmi(10));
    b.setProperty("y", mkSmi(20));
    expect(a.hiddenClass).toBe(b.hiddenClass);
  });

  it("different property order produces different hidden class", () => {
    const a = new JSObject();
    const b = new JSObject();
    a.setProperty("x", mkSmi(1));
    a.setProperty("y", mkSmi(2));
    b.setProperty("y", mkSmi(1));
    b.setProperty("x", mkSmi(2));
    expect(a.hiddenClass).not.toBe(b.hiddenClass);
  });

  it("first 10 properties stored in slots, rest in overflow", () => {
    const obj = new JSObject();
    for (let i = 0; i < 12; i++) {
      obj.setProperty(`p${i}`, mkSmi(i));
    }
    expect(obj.slots.length).toBe(10);
    expect(obj.overflowProperties.size).toBe(2);
    for (let i = 0; i < 12; i++) {
      expect(obj.getProperty(`p${i}`)).toBe(mkSmi(i));
    }
  });
});

describe("in-object slack tracking", () => {
  function construct(ctor, propNames) {
    const obj = new JSObject();
    presizeInstanceSlots(obj, ctor);
    for (let i = 0; i < propNames.length; i++) {
      obj.setProperty(propNames[i], mkSmi(i));
    }
    recordConstruction(ctor, obj);
    return obj;
  }

  it("learns the expected in-object property count from constructions", () => {
    const ctor = {};
    construct(ctor, ["a", "b", "c"]);
    expect(ctor.slackExpectedProperties).toBe(3);
  });

  it("pre-sizes a later instance to the learned count before any property is set", () => {
    const ctor = {};
    construct(ctor, ["a", "b", "c"]);
    const next = new JSObject();
    presizeInstanceSlots(next, ctor);
    expect(next.slots.length).toBe(3);
  });

  it("freezes tracking after the construction-count threshold", () => {
    const ctor = {};
    for (let i = 0; i < 7; i++) construct(ctor, ["a", "b"]);
    expect(ctor.slackTrackingComplete).toBe(true);
    const learned = ctor.slackExpectedProperties;
    construct(ctor, ["a", "b", "c", "d", "e"]);
    expect(ctor.slackExpectedProperties).toBe(learned);
  });

  it("trims slack from an instance that uses fewer properties than learned", () => {
    const ctor = {};
    construct(ctor, ["a", "b", "c", "d"]);
    const lean = new JSObject();
    presizeInstanceSlots(lean, ctor);
    lean.setProperty("a", mkSmi(0));
    recordConstruction(ctor, lean);
    expect(lean.slots.length).toBe(1);
  });

  it("preserves property values across pre-size and trim", () => {
    const ctor = {};
    construct(ctor, ["x", "y"]);
    const obj = construct(ctor, ["x", "y"]);
    expect(obj.slots.length).toBe(2);
    expect(obj.getProperty("x")).toBe(mkSmi(0));
    expect(obj.getProperty("y")).toBe(mkSmi(1));
  });

  it("caps the learned count at the in-object limit for wide objects", () => {
    const ctor = {};
    const names = [];
    for (let i = 0; i < 14; i++) names.push(`p${i}`);
    construct(ctor, names);
    expect(ctor.slackExpectedProperties).toBe(10);
  });
});

describe("JSObject delete", () => {
  it("deleteProperty removes property and reindexes", () => {
    const obj = new JSObject();
    obj.setProperty("a", mkSmi(1));
    obj.setProperty("b", mkSmi(2));
    obj.setProperty("c", mkSmi(3));
    expect(obj.deleteProperty("b")).toBe(true);
    expect(obj.hasOwnProperty("b")).toBe(false);
    expect(obj.getProperty("a")).toBe(mkSmi(1));
    expect(obj.getProperty("c")).toBe(mkSmi(3));
  });

  it("deleteProperty returns true for missing property", () => {
    const obj = new JSObject();
    expect(obj.deleteProperty("nope")).toBe(true);
  });

  it("deleteProperty returns false for non-configurable", () => {
    const obj = new JSObject();
    obj.defineProperty("x", { value: mkSmi(1), configurable: false });
    expect(obj.deleteProperty("x")).toBe(false);
  });
});

describe("JSObject storedProperty", () => {
  const withDataProps = (count: number) => {
    const obj = new JSObject();
    for (let i = 0; i < count; i++) obj.setProperty(`p${i}`, mkSmi(i));
    return obj;
  };

  it.each([0, 5, 9, 10, 15, 20])("returns an accessor pair defined after %i data properties", (count) => {
    const obj = withDataProps(count);
    const pair = new AccessorPair(mkSmi(1));
    obj.defineProperty("late", { kind: "accessor", value: pair });

    expect(obj.storedProperty("late")).toBe(pair);
  });

  it.each([0, 15])("returns a data value defined after %i data properties", (count) => {
    const obj = withDataProps(count);
    const value = mkString("v");
    obj.setProperty("late", value);

    expect(obj.storedProperty("late")).toBe(value);
  });

  it("returns undefined for an unknown property", () => {
    expect(new JSObject().storedProperty("nope")).toBeUndefined();
  });

  it("hides accessor pairs from getProperty, which reads data only", () => {
    const obj = withDataProps(15);
    obj.defineProperty("late", { kind: "accessor", value: new AccessorPair(mkSmi(1)) });

    expect(obj.getProperty("late")).toBeUndefined();
  });
});

describe("JSObject defineProperty", () => {
  it("defines property with custom attributes", () => {
    const obj = new JSObject();
    obj.defineProperty("x", { value: mkSmi(1), writable: false, enumerable: false });
    const desc = obj.getOwnPropertyDescriptor("x");
    expect(desc.writable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(desc.value).toBe(mkSmi(1));
  });

  it("non-configurable property blocks incompatible redefine", () => {
    const obj = new JSObject();
    obj.defineProperty("x", { value: mkSmi(1), configurable: false });
    expect(obj.defineProperty("x", { value: mkSmi(2), configurable: true })).toBe(false);
  });

  it("non-writable property blocks setProperty", () => {
    const obj = new JSObject();
    obj.defineProperty("x", { value: mkSmi(1), writable: false });
    expect(obj.setProperty("x", mkSmi(2))).toBe(false);
  });
});

describe("prototype chain", () => {
  it("lookupPrototypeChain finds inherited property", () => {
    const parent = new JSObject();
    parent.setProperty("inherited", mkSmi(99));
    const child = new JSObject();
    child.setPrototype(parent);
    const result = child.lookupPrototypeChain("inherited");
    expect(result.found).toBe(true);
    expect(result.value).toBe(mkSmi(99));
    expect(result.owner).toBe(parent);
    expect(result.depth).toBe(1);
  });

  it("lookupPrototypeChain returns not found for missing property", () => {
    const obj = new JSObject();
    expect(obj.lookupPrototypeChain("nope").found).toBe(false);
  });

  it("own property shadows prototype property", () => {
    const parent = new JSObject();
    parent.setProperty("x", mkSmi(1));
    const child = new JSObject();
    child.setPrototype(parent);
    child.setProperty("x", mkSmi(2));
    const result = child.lookupPrototypeChain("x");
    expect(result.value).toBe(mkSmi(2));
    expect(result.depth).toBe(0);
  });

  it("multi-level prototype chain", () => {
    const gp = new JSObject();
    gp.setProperty("deep", mkSmi(42));
    const parent = new JSObject();
    parent.setPrototype(gp);
    const child = new JSObject();
    child.setPrototype(parent);
    const result = child.lookupPrototypeChain("deep");
    expect(result.found).toBe(true);
    expect(result.depth).toBe(2);
  });
});

describe("integrity", () => {
  it("preventExtensions blocks adding new properties", () => {
    const obj = new JSObject();
    obj.setProperty("x", mkSmi(1));
    obj.preventExtensions();
    expect(obj.setProperty("y", mkSmi(2))).toBe(false);
    expect(obj.setProperty("x", mkSmi(99))).toBe(true);
  });

  it("freeze blocks all writes", () => {
    const obj = new JSObject();
    obj.setProperty("x", mkSmi(1));
    obj.freeze();
    expect(obj.setProperty("x", mkSmi(2))).toBe(false);
    expect(obj.setProperty("y", mkSmi(3))).toBe(false);
    expect(obj.getProperty("x")).toBe(mkSmi(1));
  });

  it("seal blocks delete but allows write", () => {
    const obj = new JSObject();
    obj.setProperty("x", mkSmi(1));
    obj.seal();
    expect(obj.deleteProperty("x")).toBe(false);
    expect(obj.setProperty("x", mkSmi(2))).toBe(true);
  });
});

describe("migration", () => {
  it("deprecated hidden class triggers migration on getProperty", () => {
    const obj = new JSObject();
    obj.setProperty("a", mkSmi(1));
    obj.setProperty("b", mkSmi(2));
    const oldHC = obj.hiddenClass;
    oldHC.deprecate("test");
    expect(obj.needsMigration()).toBe(true);
    expect(obj.getProperty("a")).toBe(mkSmi(1));
    expect(obj.hiddenClass).not.toBe(oldHC);
    expect(obj.needsMigration()).toBe(false);
  });

  it("migration preserves all property values", () => {
    const obj = new JSObject();
    for (let i = 0; i < 12; i++) {
      obj.setProperty(`p${i}`, mkSmi(i * 10));
    }
    obj.hiddenClass.deprecate("test");
    obj.migrateInstance();
    for (let i = 0; i < 12; i++) {
      expect(obj.getProperty(`p${i}`)).toBe(mkSmi(i * 10));
    }
  });
});

describe("lazy overflow and allocation optimizations", () => {
  it("overflowProperties is null on fresh object", () => {
    const obj = new JSObject();
    expect(obj.overflowProperties).toBeNull();
  });

  it("overflowProperties stays null with fewer than 10 properties", () => {
    const obj = new JSObject();
    for (let i = 0; i < 5; i++) {
      obj.setProperty(`p${i}`, mkSmi(i));
    }
    expect(obj.overflowProperties).toBeNull();
  });

  it("overflowProperties created lazily when exceeding 10 slots", () => {
    const obj = new JSObject();
    for (let i = 0; i < 12; i++) {
      obj.setProperty(`p${i}`, mkSmi(i));
    }
    expect(obj.overflowProperties).not.toBeNull();
    expect(obj.overflowProperties.size).toBe(2);
  });

  it("getProperty returns undefined for overflow range on fresh object", () => {
    const obj = new JSObject();
    obj.setProperty("x", mkSmi(1));
    expect(obj.getProperty("missing")).toBeUndefined();
  });

  it("visitReferences works with null overflowProperties", () => {
    const obj = new JSObject();
    obj.setProperty("x", mkSmi(1));
    const visited = [];
    obj.visitReferences((ref) => visited.push(ref));
    expect(visited).toEqual([]);
  });

  it("pre-allocates slots array from hidden class propertyCount", () => {
    const obj1 = new JSObject();
    obj1.setProperty("a", mkSmi(1));
    obj1.setProperty("b", mkSmi(2));
    const hc = obj1.hiddenClass;
    const obj2 = new JSObject(hc);
    expect(obj2.slots.length).toBe(hc.propertyCount);
  });

  it("skip invalidation for fresh single-object hidden class", () => {
    const obj = new JSObject();
    const rootHC = obj.hiddenClass;
    const versionBefore = rootHC.version;
    obj.setProperty("x", mkSmi(1));
    expect(rootHC.version).toBe(versionBefore);
  });

  it("invalidates when hidden class has enough remaining objects", () => {
    const obj1 = new JSObject();
    obj1.setProperty("x", mkSmi(1));
    const obj2 = new JSObject();
    obj2.setProperty("x", mkSmi(2));
    const obj3 = new JSObject();
    obj3.setProperty("x", mkSmi(3));
    const sharedHC = obj1.hiddenClass;
    expect(sharedHC).toBe(obj2.hiddenClass);
    expect(sharedHC).toBe(obj3.hiddenClass);
    expect(sharedHC.objectCount).toBe(3);
    const versionBefore = sharedHC.version;
    obj1.setProperty("y", mkSmi(4));
    expect(sharedHC.version).toBeGreaterThan(versionBefore);
  });
});

describe("keys/values/entries", () => {
  it("keys returns only enumerable property names", () => {
    const obj = new JSObject();
    obj.setProperty("a", mkSmi(1));
    obj.defineProperty("b", { value: mkSmi(2), enumerable: false });
    obj.setProperty("c", mkSmi(3));
    expect(obj.keys()).toEqual(["a", "c"]);
  });

  it("entries returns [name, value] pairs", () => {
    const obj = new JSObject();
    obj.setProperty("x", mkSmi(10));
    obj.setProperty("y", mkSmi(20));
    expect(obj.entries()).toEqual([
      ["x", mkSmi(10)],
      ["y", mkSmi(20)],
    ]);
  });
});

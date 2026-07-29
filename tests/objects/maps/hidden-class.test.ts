import { describe, it, expect, beforeEach } from "vitest";
import {
  HiddenClass,
  PropertyDescriptor,
  DescriptorArray,
  ROOT_HIDDEN_CLASS,
  resetHiddenClasses,
  getHiddenClassById,
  isMapDeprecated,
  getMigrationTarget,
  INTEGRITY_NONE,
  INTEGRITY_PREVENTEXTENSIONS,
  INTEGRITY_SEALED,
  INTEGRITY_FROZEN,
  MAX_TRANSITIONS_BEFORE_UNSTABLE,
} from "../../../src/objects/maps/hidden-class.js";

beforeEach(() => {
  resetHiddenClasses();
});

describe("PropertyDescriptor", () => {
  it("clone produces independent copy", () => {
    const d = new PropertyDescriptor(0, "data", true, true, true);
    const c = d.clone();
    c.writable = false;
    expect(d.writable).toBe(true);
  });

  it("equals detects differences in any field", () => {
    const base = new PropertyDescriptor(0, "data", true, true, true);
    expect(base.equals(new PropertyDescriptor(0, "data", true, true, true))).toBe(true);
    expect(base.equals(new PropertyDescriptor(1, "data", true, true, true))).toBe(false);
    expect(base.equals(new PropertyDescriptor(0, "accessor", true, true, true))).toBe(false);
    expect(base.equals(new PropertyDescriptor(0, "data", false, true, true))).toBe(false);
  });
});

describe("DescriptorArray", () => {
  it("set increments version, delete increments version", () => {
    const da = new DescriptorArray();
    expect(da.version).toBe(0);
    da.set("a", new PropertyDescriptor(0, "data", true, true, true));
    expect(da.version).toBe(1);
    da.delete("a");
    expect(da.version).toBe(2);
  });

  it("clone deep-copies descriptors", () => {
    const da = new DescriptorArray();
    da.set("x", new PropertyDescriptor(0, "data", true, true, true));
    const cloned = da.clone();
    cloned.get("x").writable = false;
    expect(da.get("x").writable).toBe(true);
  });
});

describe("HiddenClass transitions", () => {
  it("transition creates child with new property", () => {
    const hc1 = ROOT_HIDDEN_CLASS.transition("x");
    expect(hc1.hasProperty("x")).toBe(true);
    expect(hc1.propertyCount).toBe(1);
    expect(hc1.parent).toBe(ROOT_HIDDEN_CLASS);
  });

  it("same property name reuses existing transition", () => {
    const a = ROOT_HIDDEN_CLASS.transition("x");
    const b = ROOT_HIDDEN_CLASS.transition("x");
    expect(a).toBe(b);
  });

  it("different properties create different children", () => {
    const a = ROOT_HIDDEN_CLASS.transition("x");
    const b = ROOT_HIDDEN_CLASS.transition("y");
    expect(a).not.toBe(b);
    expect(a.hasProperty("x")).toBe(true);
    expect(a.hasProperty("y")).toBe(false);
    expect(b.hasProperty("y")).toBe(true);
  });

  it("chained transitions accumulate properties", () => {
    const hc1 = ROOT_HIDDEN_CLASS.transition("a");
    const hc2 = hc1.transition("b");
    const hc3 = hc2.transition("c");
    expect(hc3.propertyCount).toBe(3);
    expect(hc3.hasProperty("a")).toBe(true);
    expect(hc3.hasProperty("b")).toBe(true);
    expect(hc3.hasProperty("c")).toBe(true);
  });

  it("property offsets increment sequentially", () => {
    const hc1 = ROOT_HIDDEN_CLASS.transition("a");
    const hc2 = hc1.transition("b");
    expect(hc1.lookupProperty("a").offset).toBe(0);
    expect(hc2.lookupProperty("b").offset).toBe(1);
  });

  it("an intermediate class does not see properties added by its descendants", () => {
    const hc1 = ROOT_HIDDEN_CLASS.transition("a");
    const hc2 = hc1.transition("b");
    hc2.transition("c");
    expect(hc1.hasProperty("a")).toBe(true);
    expect(hc1.hasProperty("b")).toBe(false);
    expect(hc1.propertyCount).toBe(1);
    expect(hc2.hasProperty("c")).toBe(false);
    expect(hc2.propertyCount).toBe(2);
    expect(hc1.getPropertyNames()).toEqual(["a"]);
  });

  it("sibling branches from a shared prefix do not leak properties", () => {
    const base = ROOT_HIDDEN_CLASS.transition("a").transition("b");
    const left = base.transition("c");
    const right = base.transition("d");
    expect(left).not.toBe(right);
    expect(left.hasProperty("c")).toBe(true);
    expect(left.hasProperty("d")).toBe(false);
    expect(right.hasProperty("d")).toBe(true);
    expect(right.hasProperty("c")).toBe(false);
    expect(left.getPropertyNames()).toEqual(["a", "b", "c"]);
    expect(right.getPropertyNames()).toEqual(["a", "b", "d"]);
  });

  it("a forked branch preserves the shared-prefix offsets", () => {
    const base = ROOT_HIDDEN_CLASS.transition("a").transition("b");
    base.transition("c");
    const forked = base.transition("d");
    expect(forked.lookupProperty("a").offset).toBe(0);
    expect(forked.lookupProperty("b").offset).toBe(1);
    expect(forked.lookupProperty("d").offset).toBe(2);
    expect(forked.propertyCount).toBe(3);
  });

  it("keeps a long linear chain consistent", () => {
    const names = [];
    let hc = ROOT_HIDDEN_CLASS;
    for (let i = 0; i < 40; i++) {
      const name = `p${i}`;
      names.push(name);
      hc = hc.transition(name);
    }
    expect(hc.propertyCount).toBe(40);
    expect(hc.getPropertyNames()).toEqual(names);
    expect(hc.lookupProperty("p0").offset).toBe(0);
    expect(hc.lookupProperty("p39").offset).toBe(39);
  });

  it("deleteProperty removes property and reindexes offsets", () => {
    const hc1 = ROOT_HIDDEN_CLASS.transition("a");
    const hc2 = hc1.transition("b");
    const hc3 = hc2.transition("c");
    const deleted = hc3.deleteProperty("b");
    expect(deleted.hasProperty("b")).toBe(false);
    expect(deleted.propertyCount).toBe(2);
    expect(deleted.lookupProperty("a").offset).toBe(0);
    expect(deleted.lookupProperty("c").offset).toBe(1);
  });

  it("deleteProperty returns null for non-configurable", () => {
    const hc = ROOT_HIDDEN_CLASS.transitionWithAttributes("x", "data", true, true, false);
    expect(hc.deleteProperty("x")).toBeNull();
  });

  it("deleteProperty on missing property returns self", () => {
    expect(ROOT_HIDDEN_CLASS.deleteProperty("nope")).toBe(ROOT_HIDDEN_CLASS);
  });
});

describe("integrity transitions", () => {
  it("preventExtensions blocks new transitions", () => {
    const sealed = ROOT_HIDDEN_CLASS.transitionToPreventExtensions();
    expect(sealed.integrityLevel).toBe(INTEGRITY_PREVENTEXTENSIONS);
    expect(sealed.transition("newProp")).toBeNull();
  });

  it("seal makes all properties non-configurable", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("a").transition("b");
    const sealed = hc.transitionToSealed();
    expect(sealed.integrityLevel).toBe(INTEGRITY_SEALED);
    for (const [, desc] of sealed.properties) {
      expect(desc.configurable).toBe(false);
    }
  });

  it("freeze makes all data properties non-writable and non-configurable", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("a").transition("b");
    const frozen = hc.transitionToFrozen();
    expect(frozen.integrityLevel).toBe(INTEGRITY_FROZEN);
    for (const [, desc] of frozen.properties) {
      expect(desc.configurable).toBe(false);
      if (desc.kind === "data") expect(desc.writable).toBe(false);
    }
  });

  it("freeze chains through preventExtensions and sealed", () => {
    const frozen = ROOT_HIDDEN_CLASS.transition("x").transitionToFrozen();
    const chain = frozen.getBackPointerChain();
    const levels = chain.map((hc) => hc.integrityLevel);
    expect(levels).toContain(INTEGRITY_PREVENTEXTENSIONS);
    expect(levels).toContain(INTEGRITY_SEALED);
    expect(levels).toContain(INTEGRITY_FROZEN);
  });

  it("repeated integrity call returns same cached transition", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("x");
    const a = hc.transitionToPreventExtensions();
    const b = hc.transitionToPreventExtensions();
    expect(a).toBe(b);
  });
});

describe("stability and deprecation", () => {
  it("marks parent unstable after exceeding transition threshold", () => {
    expect(ROOT_HIDDEN_CLASS.isStable).toBe(true);
    for (let i = 0; i <= MAX_TRANSITIONS_BEFORE_UNSTABLE; i++) {
      ROOT_HIDDEN_CLASS.transition(`stability_test_${i}`);
    }
    expect(ROOT_HIDDEN_CLASS.isStable).toBe(false);
  });

  it("single transition does not mark parent unstable", () => {
    const hc = new HiddenClass(null, null, null, 0);
    expect(hc.isStable).toBe(true);
    hc.transition("x");
    expect(hc.isStable).toBe(true);
  });

  it("stays stable below transition threshold", () => {
    const hc = new HiddenClass(null, null, null, 0);
    for (let i = 0; i < MAX_TRANSITIONS_BEFORE_UNSTABLE; i++) {
      hc.transition(`below_${i}`);
    }
    expect(hc.isStable).toBe(true);
  });

  it("excessive transitions trigger deprecation on the transitioning HC", () => {
    let hc = new HiddenClass(null, null, null, 0);
    for (let i = 0; i < MAX_TRANSITIONS_BEFORE_UNSTABLE * 2 + 1; i++) {
      hc.transition(`p${i}`);
    }
    expect(hc.isDeprecated).toBe(true);
  });

  it("deprecate builds migration target with same properties", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("a").transition("b");
    const target = hc.deprecate("test");
    expect(target.hasProperty("a")).toBe(true);
    expect(target.hasProperty("b")).toBe(true);
    expect(target.propertyCount).toBe(2);
    expect(target).not.toBe(hc);
  });

  it("deprecate is idempotent", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("x");
    const t1 = hc.deprecate("first");
    const t2 = hc.deprecate("second");
    expect(t1).toBe(t2);
  });

  it("migration target preserves integrity level", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("x").transitionToSealed();
    const target = hc.deprecate("test");
    expect(target.integrityLevel).toBe(INTEGRITY_SEALED);
  });

  it("deprecated map is findable via global helpers", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("x");
    hc.deprecate("test");
    expect(isMapDeprecated(hc.id)).toBe(true);
    expect(getMigrationTarget(hc.id)).toBe(hc.migrationTarget);
  });
});

describe("transitionWithAttributes", () => {
  it("creates property with custom attributes", () => {
    const hc = ROOT_HIDDEN_CLASS.transitionWithAttributes("x", "accessor", false, true, false);
    const desc = hc.lookupProperty("x");
    expect(desc.kind).toBe("accessor");
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  it("reconfigures existing property", () => {
    const hc1 = ROOT_HIDDEN_CLASS.transition("x");
    const hc2 = hc1.transitionWithAttributes("x", "data", false, true, true);
    expect(hc2.lookupProperty("x").writable).toBe(false);
  });

  it("caches same attribute combination", () => {
    const hc = ROOT_HIDDEN_CLASS;
    const a = hc.transitionWithAttributes("x", "data", true, true, true);
    const b = hc.transitionWithAttributes("x", "data", true, true, true);
    expect(a).toBe(b);
  });
});

describe("introspection", () => {
  it("getTransitionPath returns property names root-to-leaf", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("a").transition("b").transition("c");
    expect(hc.getTransitionPath()).toEqual(["a", "b", "c"]);
  });

  it("getEnumerablePropertyNames filters non-enumerable", () => {
    const hc1 = ROOT_HIDDEN_CLASS.transition("a");
    const hc2 = hc1.transitionWithAttributes("b", "data", true, false, true);
    expect(hc2.getEnumerablePropertyNames()).toEqual(["a"]);
  });

  it("getHiddenClassById retrieves by id", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("test");
    expect(getHiddenClassById(hc.id)).toBe(hc);
  });

  it("getRoot walks to root", () => {
    const hc = ROOT_HIDDEN_CLASS.transition("a").transition("b");
    expect(hc.getRoot()).toBe(ROOT_HIDDEN_CLASS);
  });
});

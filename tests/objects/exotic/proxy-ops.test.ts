import { describe, it, expect } from "vitest";
import {
  runtimeGetProperty,
  runtimeSetProperty,
  runtimeHasProperty,
  runtimeDeleteProperty,
  runtimeOwnKeys,
  isJSProxyValue,
  createProxyValue,
} from "../../../src/objects/exotic/proxy-ops.js";
import {
  mkSmi,
  mkString,
  mkObject,
  mkArray,
  mkFunction,
  mkUndefined,
  getPayload,
  isUndefined,
} from "../../../src/core/value/index.js";
import { createJSObject, createJSArray } from "../../../src/objects/heap/factory.js";

function makeObj(props = {}) {
  const obj = createJSObject();
  for (const [k, v] of Object.entries(props)) {
    obj.setProperty(k, v);
  }
  return mkObject(obj);
}

describe("runtimeGetProperty", () => {
  it("reads named properties from plain object", () => {
    const val = mkSmi(42);
    const obj = makeObj({ x: val });
    expect(runtimeGetProperty(obj, "x")).toBe(val);
  });

  it("returns undefined for missing property", () => {
    const obj = makeObj({});
    expect(isUndefined(runtimeGetProperty(obj, "nope"))).toBe(true);
  });

  it("reads array index from tagged array", () => {
    const arr = mkArray(createJSArray([mkSmi(10), mkSmi(20)]));
    expect(getPayload(runtimeGetProperty(arr, "0"))).toBe(10);
    expect(getPayload(runtimeGetProperty(arr, "1"))).toBe(20);
  });

  it("reads .length from array", () => {
    const arr = mkArray(createJSArray([mkSmi(1), mkSmi(2), mkSmi(3)]));
    expect(getPayload(runtimeGetProperty(arr, "length"))).toBe(3);
  });

  it("reads string .length", () => {
    const str = mkString("hello");
    expect(getPayload(runtimeGetProperty(str, "length"))).toBe(5);
  });

  it("reads string character by index", () => {
    const str = mkString("abc");
    expect(getPayload(runtimeGetProperty(str, "1"))).toBe("b");
  });

  it("reads function .prototype (auto-creates if missing)", () => {
    const fn = mkFunction({ name: "Foo", compiled: null, call: null, closure: null });
    const proto = runtimeGetProperty(fn, "prototype");
    expect(getPayload(proto)).toBeDefined();
  });
});

describe("runtimeSetProperty", () => {
  it("sets named property on plain object", () => {
    const obj = makeObj({});
    runtimeSetProperty(obj, "a", mkSmi(99));
    expect(getPayload(runtimeGetProperty(obj, "a"))).toBe(99);
  });

  it("sets array element by index", () => {
    const arr = mkArray(createJSArray([mkSmi(1)]));
    runtimeSetProperty(arr, "1", mkSmi(2));
    expect(getPayload(arr).getLength()).toBe(2);
    expect(getPayload(getPayload(arr).getIndex(1))).toBe(2);
  });

  it("sets array length to truncate", () => {
    const arr = mkArray(createJSArray([mkSmi(1), mkSmi(2), mkSmi(3)]));
    runtimeSetProperty(arr, "length", mkSmi(1));
    expect(getPayload(arr).getLength()).toBe(1);
  });
});

describe("runtimeHasProperty", () => {
  it("returns true for existing object property", () => {
    const obj = makeObj({ x: mkSmi(1) });
    expect(runtimeHasProperty(obj, "x")).toBe(true);
    expect(runtimeHasProperty(obj, "y")).toBe(false);
  });

  it("returns true for valid array index", () => {
    const arr = mkArray(createJSArray([mkSmi(1), mkSmi(2)]));
    expect(runtimeHasProperty(arr, "0")).toBe(true);
    expect(runtimeHasProperty(arr, "1")).toBe(true);
    expect(runtimeHasProperty(arr, "2")).toBe(false);
  });
});

describe("runtimeDeleteProperty", () => {
  it("deletes object property", () => {
    const obj = makeObj({ x: mkSmi(1), y: mkSmi(2) });
    runtimeDeleteProperty(obj, "x");
    expect(runtimeHasProperty(obj, "x")).toBe(false);
    expect(runtimeHasProperty(obj, "y")).toBe(true);
  });
});

describe("runtimeOwnKeys", () => {
  it("returns own enumerable keys of object", () => {
    const obj = makeObj({ a: mkSmi(1), b: mkSmi(2) });
    const keys = runtimeOwnKeys(obj);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toHaveLength(2);
  });
});

describe("Proxy integration", () => {
  it("isJSProxyValue detects proxy-wrapped objects", () => {
    const target = makeObj({ x: mkSmi(1) });
    const handler = makeObj({});
    const proxy = createProxyValue(target, handler);
    expect(isJSProxyValue(proxy)).toBe(true);
    expect(isJSProxyValue(target)).toBe(false);
  });

  it("get on proxy without trap falls through to target", () => {
    const target = makeObj({ x: mkSmi(42) });
    const handler = makeObj({});
    const proxy = createProxyValue(target, handler);
    expect(getPayload(runtimeGetProperty(proxy, "x"))).toBe(42);
  });

  it("has on proxy without trap falls through to target", () => {
    const target = makeObj({ a: mkSmi(1) });
    const handler = makeObj({});
    const proxy = createProxyValue(target, handler);
    expect(runtimeHasProperty(proxy, "a")).toBe(true);
    expect(runtimeHasProperty(proxy, "b")).toBe(false);
  });

  it("set on proxy without trap falls through to target", () => {
    const target = makeObj({});
    const handler = makeObj({});
    const proxy = createProxyValue(target, handler);
    runtimeSetProperty(proxy, "z", mkSmi(100));
    expect(getPayload(runtimeGetProperty(target, "z"))).toBe(100);
  });

  it("delete on proxy without trap falls through to target", () => {
    const target = makeObj({ d: mkSmi(1) });
    const handler = makeObj({});
    const proxy = createProxyValue(target, handler);
    runtimeDeleteProperty(proxy, "d");
    expect(runtimeHasProperty(target, "d")).toBe(false);
  });

  it("ownKeys on proxy without trap falls through to target", () => {
    const target = makeObj({ p: mkSmi(1), q: mkSmi(2) });
    const handler = makeObj({});
    const proxy = createProxyValue(target, handler);
    const keys = runtimeOwnKeys(proxy);
    expect(keys).toContain("p");
    expect(keys).toContain("q");
  });
});

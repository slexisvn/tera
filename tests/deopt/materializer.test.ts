import { describe, it, expect, beforeEach } from "vitest";
import { ObjectMaterializer } from "../../src/deopt/materializer.js";
import { getPayload, isObject, isUndefined, mkSmi } from "../../src/core/value/index.js";

describe("ObjectMaterializer", () => {
  let materializer;

  beforeEach(() => {
    materializer = new ObjectMaterializer();
  });

  it("returns empty map for null/empty sunkAllocations", () => {
    expect(materializer.materialize(null, new Map()).size).toBe(0);
    expect(materializer.materialize(new Map(), new Map()).size).toBe(0);
  });

  it("materializes object with props from constant nodes", () => {
    const sunk = new Map([
      [1, {
        props: new Map([
          ["x", { id: 10, type: "Constant", props: { value: 42 } }],
        ]),
      }],
    ]);
    const result = materializer.materialize(sunk, new Map());
    expect(result.has(1)).toBe(true);
    const obj = getPayload(result.get(1));
    expect(obj.getProperty("x")).toBe(42);
  });

  it("materializes object with fields at offsets", () => {
    const sunk = new Map([
      [2, {
        fields: new Map([
          [0, { id: 20, type: "Constant", props: { value: 99 } }],
          [2, { id: 21, type: "Constant", props: { value: 77 } }],
        ]),
      }],
    ]);
    const result = materializer.materialize(sunk, new Map());
    const obj = getPayload(result.get(2));
    expect(obj.slots[0]).toBe(99);
    expect(obj.slots[2]).toBe(77);
  });

  it("resolves values from runtimeValues", () => {
    const runtimeVal = mkSmi(123);
    const sunk = new Map([
      [3, {
        props: new Map([["y", { id: 30 }]]),
      }],
    ]);
    const runtimeValues = new Map([[30, runtimeVal]]);
    const result = materializer.materialize(sunk, runtimeValues);
    const obj = getPayload(result.get(3));
    expect(obj.getProperty("y")).toBe(runtimeVal);
  });

  it("resolves values from already-materialized objects", () => {
    const innerVState = {
      props: new Map([["val", { id: 50, type: "Constant", props: { value: 1 } }]]),
    };
    const outerVState = {
      props: new Map([["child", { id: 100 }]]),
    };
    const sunk = new Map([
      [100, innerVState],
      [200, outerVState],
    ]);
    const result = materializer.materialize(sunk, new Map());
    expect(result.has(100)).toBe(true);
    const outerObj = getPayload(result.get(200));
    expect(isObject(outerObj.getProperty("child"))).toBe(true);
  });

  it("returns mkUndefined for null valueNode", () => {
    const sunk = new Map([
      [4, { props: new Map([["z", null]]) }],
    ]);
    const result = materializer.materialize(sunk, new Map());
    const obj = getPayload(result.get(4));
    expect(isUndefined(obj.getProperty("z"))).toBe(true);
  });

  it("passes through raw number values", () => {
    const tagged = mkSmi(55);
    const sunk = new Map([
      [5, { props: new Map([["n", tagged]]) }],
    ]);
    const result = materializer.materialize(sunk, new Map());
    const obj = getPayload(result.get(5));
    expect(obj.getProperty("n")).toBe(tagged);
  });
});

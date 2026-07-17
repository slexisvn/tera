import { describe, it, expect } from "vitest";
import { createBuiltinPrototypes } from "../../../src/runtime/intrinsics/prototypes.js";
import { isFunction, wellKnownSymbols } from "../../../src/core/value/index.js";

describe("createBuiltinPrototypes", () => {
  const protos = createBuiltinPrototypes();

  it("returns all 8 prototype objects", () => {
    const keys = [
      "stringPrototype", "arrayPrototype", "numberPrototype",
      "booleanPrototype", "regexPrototype", "mapPrototype",
      "setPrototype", "weakMapPrototype",
    ];
    for (const key of keys) {
      expect(protos[key]).toBeDefined();
    }
  });

  it("prototypes contain callable functions for each method", () => {
    const methodChecks = [
      ["stringPrototype", ["charAt", "slice", "indexOf", "split", "trim", "replace"]],
      ["arrayPrototype", ["push", "pop", "map", "filter", "reduce", "sort", "splice"]],
      ["numberPrototype", ["toString", "toFixed", "toPrecision"]],
      ["booleanPrototype", ["toString", "valueOf"]],
      ["regexPrototype", ["test", "exec", "toString"]],
      ["mapPrototype", ["get", "set", "has", "delete", "clear", "forEach", "entries"]],
      ["setPrototype", ["add", "has", "delete", "clear", "forEach", "values"]],
      ["weakMapPrototype", ["get", "set", "has", "delete"]],
    ];
    for (const [protoName, methods] of methodChecks) {
      for (const method of methods) {
        expect(isFunction(protos[protoName].getProperty(method))).toBe(true);
      }
    }
  });

  it("mapPrototype has Symbol.iterator pointing to entries", () => {
    if (!wellKnownSymbols.iterator) return;
    const iterFn = protos.mapPrototype.getSymbolProperty(wellKnownSymbols.iterator);
    const entriesFn = protos.mapPrototype.getProperty("entries");
    expect(iterFn).toBeDefined();
    expect(iterFn).toBe(entriesFn);
  });

  it("setPrototype has Symbol.iterator pointing to values", () => {
    if (!wellKnownSymbols.iterator) return;
    const iterFn = protos.setPrototype.getSymbolProperty(wellKnownSymbols.iterator);
    const valuesFn = protos.setPrototype.getProperty("values");
    expect(iterFn).toBeDefined();
    expect(iterFn).toBe(valuesFn);
  });
});

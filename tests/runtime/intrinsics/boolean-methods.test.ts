import { describe, it, expect } from "vitest";
import { BOOLEAN_METHODS } from "../../../src/runtime/intrinsics/boolean-methods.js";
import {
  mkBool,
  mkSmi,
  mkObject,
  getPayload,
} from "../../../src/core/value/index.js";
import { createJSObject } from "../../../src/objects/heap/factory.js";

function callMethod(name, thisVal, ...args) {
  return BOOLEAN_METHODS[name].call(args, thisVal);
}

describe("BOOLEAN_METHODS", () => {
  describe("toString", () => {
    it("converts boolean primitives to string", () => {
      expect(getPayload(callMethod("toString", mkBool(true)))).toBe("true");
      expect(getPayload(callMethod("toString", mkBool(false)))).toBe("false");
    });

    it("unwraps Boolean wrapper object", () => {
      const wrapper = createJSObject();
      wrapper._primitiveValue = mkBool(true);
      expect(getPayload(callMethod("toString", mkObject(wrapper)))).toBe("true");
    });
  });

  describe("valueOf", () => {
    it("returns tagged boolean for primitives", () => {
      expect(callMethod("valueOf", mkBool(true))).toBe(mkBool(true));
      expect(callMethod("valueOf", mkBool(false))).toBe(mkBool(false));
    });

    it("unwraps Boolean wrapper object", () => {
      const wrapper = createJSObject();
      wrapper._primitiveValue = mkBool(false);
      expect(callMethod("valueOf", mkObject(wrapper))).toBe(mkBool(false));
    });
  });
});

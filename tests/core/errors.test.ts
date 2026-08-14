import { describe, it, expect } from "vitest";
import {
  VMError,
  VMTypeError,
  VMReferenceError,
  VMRangeError,
  VMSyntaxError,
  isVMError,
  vmErrorToTagged,
} from "../../src/core/errors/index.js";

describe("VMError toString", () => {
  it("formats as Type: message", () => {
    expect(new VMTypeError("boom").toString()).toBe("TypeError: boom");
    expect(new VMReferenceError("x").toString()).toBe("ReferenceError: x");
    expect(new VMRangeError("bad").toString()).toBe("RangeError: bad");
    expect(new VMSyntaxError("wat").toString()).toBe("SyntaxError: wat");
  });
});

describe("isVMError", () => {
  it("returns true for VMError and all subtypes", () => {
    expect(isVMError(new VMError("Error", "x"))).toBe(true);
    expect(isVMError(new VMTypeError("x"))).toBe(true);
    expect(isVMError(new VMReferenceError("x"))).toBe(true);
    expect(isVMError(new VMRangeError("x"))).toBe(true);
    expect(isVMError(new VMSyntaxError("x"))).toBe(true);
  });

  it("returns false for native Error and plain objects", () => {
    expect(isVMError(new Error("x"))).toBe(false);
    expect(isVMError({ type: "TypeError", message: "x" })).toBe(false);
    expect(isVMError(null)).toBe(false);
    expect(isVMError("string")).toBe(false);
  });
});

describe("vmErrorToTagged", () => {
  it("creates tagged object with name/message/stack properties", () => {
    const err = new VMTypeError("bad call");
    let capturedObj = null;
    const fakeMkString = (s) => `str:${s}`;
    const fakeMkObject = (obj) => ({ tagged: true, obj });
    const fakeCreateJSObject = () => {
      const props = new Map();
      capturedObj = {
        setProperty(k, v) { props.set(k, v); },
        props,
      };
      return capturedObj;
    };
    const result = vmErrorToTagged(err, fakeMkString, fakeMkObject, fakeCreateJSObject);
    expect(result.tagged).toBe(true);
    expect(capturedObj.props.get("name")).toBe("str:TypeError");
    expect(capturedObj.props.get("message")).toBe("str:bad call");
    expect(capturedObj.props.has("stack")).toBe(true);
  });
});

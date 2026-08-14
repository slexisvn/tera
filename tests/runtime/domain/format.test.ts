import { describe, it, expect } from "vitest";
import * as mlfw from "@slexisvn/mlfw";
import { formatHostValue } from "../../../src/runtime/domain/format.js";

const tensor = (mlfw as Record<string, unknown>).tensor as (...args: unknown[]) => unknown;
const zeros = (mlfw as Record<string, unknown>).zeros as (...args: unknown[]) => unknown;

describe("formatHostValue", () => {
  describe("multi-element tensors", () => {
    const small = () => tensor([[1.0, 2.0], [3.0, 4.0]]);

    it("puts the elements under the header in full form", () => {
      expect(formatHostValue(small(), false)).toBe("Tensor(shape=[2, 2], dtype=f32)\n[[1,2],[3,4]]");
    });

    it("shows only the elements in compact form", () => {
      expect(formatHostValue(small(), true)).toBe("[[1,2],[3,4]]");
    });
  });

  describe("scalar tensors", () => {
    it("shows the value with its dtype in full form", () => {
      expect(formatHostValue(tensor(5.0), false)).toBe("Tensor(5, dtype=f32)");
    });

    it("shows only the value in compact form", () => {
      expect(formatHostValue(tensor(5.0), true)).toBe("5");
    });
  });

  describe("the inline element limit", () => {
    it("inlines a tensor at the 64-element limit", () => {
      const formatted = formatHostValue(zeros([8, 8]), false) as string;
      expect(formatted.startsWith("Tensor(shape=[8, 8], dtype=f32)\n")).toBe(true);
      expect(formatted).toContain("[[0,0,0,0,0,0,0,0]");
    });

    it("drops the elements once past the limit", () => {
      expect(formatHostValue(zeros([65]), false)).toBe("Tensor(shape=[65], dtype=f32)");
      expect(formatHostValue(zeros([9, 9]), false)).toBe("Tensor(shape=[9, 9], dtype=f32)");
    });

    it("keeps the header in compact form for a large tensor", () => {
      expect(formatHostValue(zeros([9, 9]), true)).toBe("Tensor(shape=[9, 9], dtype=f32)");
    });
  });

  describe("device suffix", () => {
    it("omits the suffix for cpu", () => {
      expect(formatHostValue(tensor([[1.0]], { device: mlfw.CPU_DEVICE }), false)).not.toContain("device=");
    });
  });

  describe("non-tensor values", () => {
    it("returns undefined so the caller can fall back", () => {
      expect(formatHostValue({ plain: true }, false)).toBeUndefined();
      expect(formatHostValue("text", false)).toBeUndefined();
      expect(formatHostValue(42, false)).toBeUndefined();
      expect(formatHostValue(null, false)).toBeUndefined();
      expect(formatHostValue(undefined, false)).toBeUndefined();
    });
  });
});

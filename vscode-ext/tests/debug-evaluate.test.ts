import { describe, expect, it } from "vitest";
import { evaluateDebugExpression } from "../src/client/debug/evaluate.ts";

const env = {
  locals: [{
    name: "x",
    slot: 0,
    kind: "let",
    value: { tag: "smi", display: "6", raw: 6 },
  }],
  globals: [{
    name: "add10",
    slot: 0,
    kind: "global",
    value: { tag: "function", display: "[Function: add]" },
  }, {
    name: "nums",
    slot: 1,
    kind: "global",
    value: {
      tag: "array",
      display: "[3, 1, 4]",
      children: [
        { name: "length", value: { tag: "smi", display: "3", raw: 3 } },
        { name: "0", value: { tag: "smi", display: "3", raw: 3 } },
        { name: "1", value: { tag: "smi", display: "1", raw: 1 } },
        { name: "2", value: { tag: "smi", display: "4", raw: 4 } },
      ],
    },
  }],
};

describe("debug expression evaluator", () => {
  it("evaluates pure watch expressions over locals and globals", () => {
    expect(evaluateDebugExpression("x + nums[2]", env).raw).toBe(10);
    expect(evaluateDebugExpression("nums.length === 3 && x > 5", env).raw).toBe(true);
  });

  it("rejects function calls", () => {
    expect(() => evaluateDebugExpression("add10(5)", env)).toThrow(/Function calls/);
  });
});

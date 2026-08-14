import { describe, expect, it } from "vitest";
import { buildDispatch } from "../../../src/optimizing/infra/dispatch.js";

describe("buildDispatch", () => {
  it("invokes the handler registered for a key and reports a hit", () => {
    const seen: string[] = [];
    const dispatch = buildDispatch<string, { tag: string }>([
      ["add", (context) => seen.push(`add:${context.tag}`)],
      ["sub", (context) => seen.push(`sub:${context.tag}`)],
    ]);

    expect(dispatch("add", { tag: "x" })).toBe(true);
    expect(dispatch("sub", { tag: "y" })).toBe(true);
    expect(seen).toEqual(["add:x", "sub:y"]);
  });

  it("reports a miss and runs nothing for an unknown key", () => {
    const seen: string[] = [];
    const dispatch = buildDispatch<string, { tag: string }>([
      ["add", (context) => seen.push(context.tag)],
    ]);

    expect(dispatch("unknown", { tag: "z" })).toBe(false);
    expect(seen).toEqual([]);
  });

  it("lets a later entry win when a key is duplicated", () => {
    const seen: string[] = [];
    const dispatch = buildDispatch<string, null>([
      ["k", () => seen.push("first")],
      ["k", () => seen.push("second")],
    ]);

    dispatch("k", null);
    expect(seen).toEqual(["second"]);
  });
});

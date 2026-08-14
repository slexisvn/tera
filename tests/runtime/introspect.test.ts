import { describe, expect, it } from "vitest";
import { parseReceiverPath } from "../../src/runtime/introspect.js";

describe("parseReceiverPath", () => {
  it("accepts identifier chains", () => {
    expect(parseReceiverPath("a")).toEqual(["a"]);
    expect(parseReceiverPath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("rejects calls, indexing, and non-identifier expressions", () => {
    expect(parseReceiverPath("f()")).toBeNull();
    expect(parseReceiverPath("xs[0]")).toBeNull();
    expect(parseReceiverPath("a + b")).toBeNull();
    expect(parseReceiverPath("")).toBeNull();
  });
});

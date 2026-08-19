import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const hot = (...body: string[]) =>
  differential(
    src(
      ...body,
      "fn run(n):",
      "  last = 0",
      "  i = 0",
      "  while (i < n):",
      "    i = (i + 1)",
      "    last = f0(i)",
      "  return last",
      "run(1200)",
    ),
  );

/**
 * A local array literal never escapes, so scalar replacement is free to answer its
 * elements from the values that were stored. A negative subscript names one of those
 * same elements, not a slot of its own, which is the case that used to read back as
 * undefined once the function was hot.
 */
describe("a negative subscript on an array the frame never lets go of", () => {
  it("counts back from the end of an int literal", () => {
    expect(hot("fn f0(p0):", "  xs = [3, 1, 2]", "  return xs[-1]")).toEqual(2);
    expect(hot("fn f0(p0):", "  xs = [3, 1, 2]", "  return xs[-3]")).toEqual(3);
  });

  it("counts back from the end of a text literal", () => {
    expect(hot("fn f0(p0):", '  ts = ["a", "b"]', "  return ts[-1]")).toEqual("b");
    expect(hot("fn f0(p0):", '  ts = ["a", "b"]', "  return ts[-2]")).toEqual("a");
  });

  it("counts back through both levels of a nested literal", () => {
    expect(hot("fn f0(p0):", "  m = [[1, 2], [3, 4]]", "  return m[-1][-1]")).toEqual(4);
    expect(hot("fn f0(p0):", "  m = [[1, 2], [3, 4]]", "  return m[-2][0]")).toEqual(1);
  });

  it("answers undefined past either end rather than throwing", () => {
    expect(hot("fn f0(p0):", '  ts = ["a", "b"]', "  return ts[-3]")).toEqual(undefined);
    expect(hot("fn f0(p0):", '  ts = ["a", "b"]', "  return ts[9]")).toEqual(undefined);
  });

  it("writes through a negative subscript", () => {
    expect(hot("fn f0(p0):", '  ts = ["a", "b"]', '  ts[-1] = "z"', "  return ts[1]")).toEqual(
      "z",
    );
  });

  it("keeps reading the positive subscripts it always could", () => {
    expect(hot("fn f0(p0):", '  ts = ["a", "b"]', "  return ts[0]")).toEqual("a");
    expect(hot("fn f0(p0):", "  m = [[1, 2], [3, 4]]", "  return m[1][0]")).toEqual(3);
  });

  it("reaches the same element a positive subscript would, when the elements are objects", () => {
    const literal = ["fn f0(p0):", "  xs = [{ a: 1 }, { a: 2 }]"];
    expect(hot(...literal, "  return xs[-1].a")).toEqual(2);
    expect(hot(...literal, "  return xs[-2].a")).toEqual(1);
    expect(hot(...literal, "  return xs[1].a + xs[-1].a")).toEqual(4);
    expect(hot(...literal, "  o = xs[-1]", "  return o.a")).toEqual(2);
  });
});

describe("a negative subscript on an array that outlives the frame", () => {
  it("counts back after the array was handed to a callee", () => {
    expect(
      hot("fn last(ys):", "  return ys[-1]", "fn f0(p0):", '  ts = ["a", "b"]', "  return last(ts)"),
    ).toEqual("b");
  });

  it("counts back on an array a global holds", () => {
    expect(hot('g = ["a", "b", "c"]', "fn f0(p0):", "  return g[-1]")).toEqual("c");
  });

  it("counts back on an array a field holds", () => {
    expect(hot("o = { xs: [1, 2, 3] }", "fn f0(p0):", "  return o.xs[-1]")).toEqual(3);
  });

  it("counts back through an index the loop recomputes", () => {
    expect(hot('g = ["a", "b", "c"]', "fn f0(p0):", "  return g[0 - (p0 % 3) - 1]")).toEqual("c");
  });
});

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

const reading = (subscript: string) =>
  hot("fn f0(p0):", "  xs = [1, 2, 3]", `  return xs${subscript}`);

describe("a hot array subscript answers what the interpreter answers", () => {
  it("counts back from the end on a negative index", () => {
    expect(reading("[-1]")).toEqual(3);
    expect(reading("[-3]")).toEqual(1);
  });

  it("reads the same element as the interpreter on a positive index", () => {
    expect(reading("[0]")).toEqual(1);
    expect(reading("[2]")).toEqual(3);
  });

  it("answers undefined past either end rather than faulting", () => {
    expect(reading("[3]")).toEqual(undefined);
    expect(reading("[-4]")).toEqual(undefined);
  });

  it("answers undefined for every subscript of an empty array", () => {
    expect(hot("fn f0(p0):", "  xs = []", "  return xs[0]")).toEqual(undefined);
    expect(hot("fn f0(p0):", "  xs = []", "  return xs[-1]")).toEqual(undefined);
  });

  it("writes through a negative index the way the interpreter does", () => {
    expect(hot("fn f0(p0):", "  xs = [1, 2, 3]", "  xs[-1] = 9", "  return xs[2]")).toEqual(9);
  });

  it("counts back from a length that a push and a pop moved", () => {
    expect(
      hot("fn f0(p0):", "  xs = [1]", "  xs.push(2)", "  xs.push(3)", "  return xs[-1]"),
    ).toEqual(3);
    expect(hot("fn f0(p0):", "  xs = [1, 2, 3]", "  xs.pop()", "  return xs[-1]")).toEqual(2);
  });

  it("counts back through an index the loop recomputes each turn", () => {
    expect(hot("fn f0(p0):", "  xs = [1, 2, 3]", "  return xs[0 - (p0 % 3) - 1]")).toEqual(3);
  });
});

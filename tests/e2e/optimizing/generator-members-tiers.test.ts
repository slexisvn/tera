import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const GEN = ["fn* gen():", "  yield 1", "  yield 2"];

const inLoop = (...body: string[]) =>
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
      "run(400)",
    ),
  );

/**
 * Compiled code reaches a generator's members through its own property lookup, which
 * used to run out of branches before it got to generators and hand back undefined —
 * so `it.next` was not a function once the caller was warm enough to leave the interpreter.
 */
describe("members of a receiver the compiled lookup has to branch for", () => {
  it("advances an iterator made inside the hot function", () => {
    expect(inLoop(...GEN, "fn f0(p0):", "  it = gen()", "  return it.next().value")).toEqual(1);
  });

  it("advances the same iterator twice", () => {
    expect(
      inLoop(
        ...GEN,
        "fn f0(p0):",
        "  it = gen()",
        "  return it.next().value + it.next().value",
      ),
    ).toEqual(3);
  });

  it("reports done once the generator is spent", () => {
    expect(
      inLoop("fn* one():", "  yield 1", "fn f0(p0):", "  it = one()", "  it.next()", "  return it.next().done"),
    ).toEqual(true);
  });

  it("answers undefined for the value past the end", () => {
    expect(
      inLoop("fn* one():", "  yield 1", "fn f0(p0):", "  it = one()", "  it.next()", "  return it.next().value"),
    ).toEqual(undefined);
  });

  it("walks the generator with for-of", () => {
    expect(
      inLoop(...GEN, "fn f0(p0):", "  t = 0", "  for v of gen():", "    t = t + v", "  return t"),
    ).toEqual(3);
  });

  it("reads a regex member from compiled code", () => {
    expect(inLoop("fn f0(p0):", "  r = /ab/", "  return r.source")).toEqual("ab");
    expect(inLoop("fn f0(p0):", "  r = /ab/g", "  return r.flags")).toEqual("g");
    expect(inLoop("fn f0(p0):", "  r = /ab/", '  return r.test("xaby")')).toEqual(true);
  });

  it("yields an element a negative subscript reached", () => {
    expect(
      inLoop(
        "fn* last():",
        '  ts = ["a", "b"]',
        "  yield ts[-1]",
        "fn f0(p0):",
        "  it = last()",
        "  return it.next().value",
      ),
    ).toEqual("b");
  });
});

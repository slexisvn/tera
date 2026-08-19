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
  hot("fn f0(p0):", '  s = "abcde"', `  return s${subscript}`);

describe("a hot string subscript answers what the interpreter answers", () => {
  it("counts back from the end on a negative index", () => {
    expect(reading("[-1]")).toEqual("e");
    expect(reading("[-5]")).toEqual("a");
  });

  it("reads the same character as the interpreter on a positive index", () => {
    expect(reading("[0]")).toEqual("a");
    expect(reading("[4]")).toEqual("e");
  });

  it("answers undefined past either end rather than faulting", () => {
    expect(reading("[5]")).toEqual(undefined);
    expect(reading("[-6]")).toEqual(undefined);
  });

  it("answers undefined for every subscript of an empty string", () => {
    expect(hot("fn f0(p0):", '  e = ""', "  return e[0]")).toEqual(undefined);
    expect(hot("fn f0(p0):", '  e = ""', "  return e[-1]")).toEqual(undefined);
  });
});

describe("hot builtins keep answering outside their domain", () => {
  it("answers NaN for a character code off either end", () => {
    expect(hot("fn f0(p0):", '  s = "abcde"', "  return s.char_code_at(9)")).toBeNaN();
    expect(hot("fn f0(p0):", '  s = "abcde"', "  return s.char_code_at(-1)")).toBeNaN();
  });

  it("answers NaN for a remainder by zero", () => {
    expect(hot("fn f0(p0):", "  z = 0", "  return 7 % z")).toBeNaN();
  });

  it("keeps a remainder by a non-zero divisor exact", () => {
    expect(hot("fn f0(p0):", "  d = 3", "  return 7 % d")).toEqual(1);
  });

  it("fills the gaps of an empty needle the way the interpreter does", () => {
    expect(hot("fn f0(p0):", '  s = "abcde"', '  return s.replace("", "-")')).toEqual(
      "-abcde",
    );
    expect(hot("fn f0(p0):", '  s = "abcde"', '  return s.replace_all("", "-")')).toEqual(
      "a-b-c-d-e",
    );
  });
});

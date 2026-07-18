import { describe, expect, it } from "vitest";
import { Engine } from "../../src/index.js";

const run = (source: string) => new Engine().runValue(source).value;

describe("Tera control flow", () => {
  it("runs Python-style if, while, for-of, and for-in blocks", () => {
    const source = [
      "sum = 0",
      "for x of [1, 2, 3, 4]:",
      "  if x % 2 == 0:",
      "    sum = sum + x",
      "obj = { a: 1, b: 2 }",
      "keys = \"\"",
      "for k in obj:",
      "  keys = keys + k",
      "n = 0",
      "while n < 3:",
      "  sum = sum + n",
      "  n = n + 1",
      "sum * 10 + keys.length",
    ].join("\n");
    expect(run(source)).toBe(92);
  });

  describe("parser surface", () => {
    const output = (source: string) => {
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative(source);
      return out.join("|");
    };

    it("chains else if branches", () => {
      const grade = [
        "fn grade(n):",
        "  if n >= 90:",
        "    return \"A\"",
        "  else if n >= 75:",
        "    return \"B\"",
        "  else if n >= 60:",
        "    return \"C\"",
        "  else:",
        "    return \"F\"",
      ].join("\n");
      expect(output(`${grade}\nprint(grade(95), grade(80), grade(65), grade(40))`)).toBe("A B C F");
    });

    it("ignores hash line comments, whole-line and trailing", () => {
      expect(output("# header\nx = 1  # trailing\n# between\nprint(x)")).toBe("1");
    });

    it("destructures a bare tuple on the left of an assignment", () => {
      expect(output("a, b, c = [10, 20, 30]\nprint(a + b + c)")).toBe("60");
    });

    it("destructures a bare tuple from a call result", () => {
      expect(output("fn pair():\n  return [7, 8]\np, q = pair()\nprint(p, q)")).toBe("7 8");
    });

    it("runs an offside switch with case and default", () => {
      const f = [
        "fn name(v):",
        "  switch v:",
        "    case 1:",
        "      return \"one\"",
        "    case 2:",
        "      return \"two\"",
        "    default:",
        "      return \"other\"",
      ].join("\n");
      expect(output(`${f}\nprint(name(1), name(2), name(9))`)).toBe("one two other");
    });

    it("still accepts a parenthesised switch discriminant", () => {
      const f = "fn f(v):\n  switch (v):\n    case 1:\n      return \"a\"\n    default:\n      return \"z\"";
      expect(output(`${f}\nprint(f(1), f(5))`)).toBe("a z");
    });

    it("evaluates a list comprehension over an iterable", () => {
      expect(output("print([x * x for x of [1, 2, 3, 4]])")).toBe("[1, 4, 9, 16]");
    });

    it("accepts the Python-style `in` in a comprehension", () => {
      expect(output("rows = [{v: 5}, {v: 8}]\nprint([r.v for r in rows])")).toBe("[5, 8]");
    });

    it("filters a comprehension with a trailing if", () => {
      expect(output("print([n for n of range(6) if n % 2 == 0])")).toBe("[0, 2, 4]");
    });

    it("does not confuse a two-element array with a comprehension", () => {
      expect(output("print([1, 2].length)")).toBe("2");
    });
  });

  describe("for-in enumeration", () => {
    const collect = (source: string) => {
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative(source);
      return out;
    };

    it("enumerates array indices", () => {
      expect(collect("for i in [10, 20]:\n  print(i)")).toEqual(["0", "1"]);
    });

    it("enumerates indices produced by range", () => {
      expect(collect("for i in range(3):\n  print(i)")).toEqual(["0", "1", "2"]);
    });

    it("enumerates string indices", () => {
      expect(collect('for c in "ab":\n  print(c)')).toEqual(["0", "1"]);
    });

    it("enumerates array indices before named properties", () => {
      expect(collect('a = [1, 2]\na.tag = "t"\nfor k in a:\n  print(k)')).toEqual(["0", "1", "tag"]);
    });

    it("skips holes in sparse arrays", () => {
      expect(collect("a = [1]\na[3] = 9\nfor k in a:\n  print(k)")).toEqual(["0", "3"]);
    });

    it("yields nothing for values without enumerable keys", () => {
      expect(collect("for k in 42:\n  print(k)")).toEqual([]);
    });

    it("still yields values with for-of", () => {
      expect(collect("for v of [10, 20]:\n  print(v)")).toEqual(["10", "20"]);
    });
  });

  it("runs destructuring assignment in blocks", () => {
    const source = [
      "[a, [b, c]] = [1, [2, 3]]",
      "{x, y} = { x: 4, y: 5 }",
      "a + b + c + x + y",
    ].join("\n");
    expect(run(source)).toBe(15);
  });

  it("catches thrown values and always runs finally", () => {
    const source = [
      "out = 0",
      "try:",
      "  throw \"x\"",
      "catch e:",
      "  out = 3",
      "finally:",
      "  out = out + 1",
      "out",
    ].join("\n");
    expect(run(source)).toBe(4);
  });

  it("runs labeled indentation blocks with labeled break", () => {
    const source = [
      "total = 0",
      "outer:",
      "  for x of [1, 2, 3, 4, 5]:",
      "    if x == 4:",
      "      break outer",
      "    if x == 2:",
      "      continue",
      "    total = total + x",
      "total",
    ].join("\n");
    expect(run(source)).toBe(4);
  });
});

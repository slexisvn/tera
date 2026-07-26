import { describe, expect, it } from "vitest";
import { differential, src, type Tier } from "./_tiers.js";

const jitOsr: Tier[] = ["jit", "osr"];

const value = (expr: string) => differential(src(`x = ${expr}`, "[x]"), { tiers: jitOsr });

const hot = (expr: string, tiers = jitOsr) =>
  differential(
    src(
      "fn f0(p0):",
      `  return ${expr}`,
      "fn run(n):",
      "  last = 0",
      "  i = 0",
      "  while (i < n):",
      "    i = (i + 1)",
      "    last = f0(i)",
      "  return last",
      "run(1200)",
    ),
    { tiers },
  );

describe("computed string-key access matches dot access on a string", () => {
  it("reads length, a character, and a method via a computed key", () => {
    expect(value('("hello")["length"]')).toEqual([5]);
    expect(value('("hello")["length"]')).toEqual(value('("hello").length'));
    expect(value('("hello")["1"]')).toEqual(["e"]);
    expect(value('("hello")["substring"](0, 2)')).toEqual(["he"]);
    expect(value('("hello")["substring"](0, 3)')).toEqual(value('("hello").substring(0, 3)'));
  });

  it("keeps optional computed access short-circuiting on nullish", () => {
    expect(value('(null)?.["substring"](0, 2)')).toEqual([undefined]);
    expect(value('(undefined)?.["length"]')).toEqual([undefined]);
  });

  it("indexes a string with a negative (python-style) index", () => {
    expect(value('("abcd")[-1]')).toEqual(["d"]);
    expect(value('("abcd")?.[-2]')).toEqual(["c"]);
    expect(value('("abc")?.[-9]')).toEqual([undefined]);
  });

  it("resolves computed string keys on a hot (compiled) call", () => {
    expect(hot('(("1024")?.["0"])?.[0]')).toEqual("1");
    expect(hot('("hello")["substring"](1, 3)')).toEqual("el");
    expect(hot('("abcd")?.[-1]')).toEqual("d");
  }, 30000);

  it("works on a computed key held in a variable", () => {
    expect(
      differential(src('k = "substring"', 's = "hello"', "x = (s)[k](0, 2)", "[x]"), {
        tiers: jitOsr,
      }),
    ).toEqual(["he"]);
  });
});

describe("an optional method call keeps its receiver", () => {
  it("calls a string method on the string, not on undefined", () => {
    expect(value('("hello")?.substring(0, 2)')).toEqual(["he"]);
    expect(value('("hello")?.substring(0, 2)')).toEqual(value('("hello").substring(0, 2)'));
    expect(hot('("hello")?.substring(0, 2)')).toEqual("he");
    expect(hot('(("" + "abcdef"))?.substring(1, 4)')).toEqual("bcd");
  });

  it("short-circuits to undefined on a nullish receiver", () => {
    expect(value("(null)?.substring(0, 2)")).toEqual([undefined]);
    expect(hot("(null)?.substring(0, 2)")).toEqual(undefined);
    expect(value('("hello")?.length')).toEqual([5]);
  });

  it("calls a method on an object receiver", () => {
    expect(
      differential(
        src(
          "fn twice(self):",
          "  return (self.n * 2)",
          "o = {n: 4, t: twice}",
          "x = (o)?.t(o)",
          "[x]",
        ),
        { tiers: jitOsr },
      ),
    ).toEqual([8]);
  });
});

describe("function member access agrees across every tier when hot", () => {
  const tiers: Tier[] = ["baseline", "jit", "osr"];
  const fm = (expr: string) =>
    differential(
      src(
        "fn g(a, b):",
        "  return (a + b)",
        "fn k(p0):",
        "  fn inner(q0):",
        "    return 0",
        "  return inner",
        "fn run(n):",
        `  return ${expr}`,
        "fn driver(m):",
        "  i = 0",
        "  last = 0",
        "  while (i < m):",
        "    i = (i + 1)",
        "    last = run(3)",
        "  return last",
        "[driver(40)]",
      ),
      { tiers },
    );

  it("reads .length (arity) and .name, including on a returned closure", () => {
    expect(fm("(g).length")).toEqual([2]);
    expect(fm("(k(0)).length")).toEqual([1]);
    expect(fm("(g).name")).toEqual(["g"]);
    expect(fm("(k(0))?.length")).toEqual([1]);
  });

  it("invokes a function via .call and .apply", () => {
    expect(fm("(g).call(0, 4, 5)")).toEqual([9]);
    expect(fm("(g).apply(0, [4, 5])")).toEqual([9]);
  });

  it("keeps a user-set own property winning over a builtin member", () => {
    expect(
      differential(
        src(
          "fn g(a, b):",
          "  return 0",
          "fn run(n):",
          "  g.length = 99",
          "  return (g).length",
          "fn driver(m):",
          "  i = 0",
          "  last = 0",
          "  while (i < m):",
          "    i = (i + 1)",
          "    last = run(3)",
          "  return last",
          "[driver(40)]",
        ),
        { tiers },
      ),
    ).toEqual([99]);
  });
});

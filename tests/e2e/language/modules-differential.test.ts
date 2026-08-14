import { afterEach, describe, expect, it } from "vitest";
import { cleanModuleProjects, differentialModules, src } from "../../helpers/tiers.js";

afterEach(() => cleanModuleProjects());

const hot = (call: string, iterations = 400) =>
  src(
    "fn work(n: int) -> int:",
    "  acc = 0",
    "  i = 0",
    "  while (i < n):",
    `    acc = (acc + ${call})`,
    "    i = (i + 1)",
    "  return acc",
    "total = 0",
    "r = 0",
    "while (r < 12):",
    `  total = work(${iterations})`,
    "  r = (r + 1)",
    "total",
    "",
  );

describe("multi-module programs agree across tiers", () => {
  it("calls an imported numeric function in a hot loop", () => {
    expect(
      differentialModules({
        "main.tera": `from mathlib import square\n${hot("square(i)")}`,
        "mathlib.tera": "fn square(n: int) -> int:\n  return n * n\n",
      }),
    ).toBe(21253400);
  });

  it("reads an imported module-level constant in a hot loop", () => {
    expect(
      differentialModules({
        "main.tera": `from config import factor\n${hot("(i * factor)")}`,
        "config.tera": "factor = 3\n",
      }),
    ).toBe(239400);
  });

  it("reaches a function through a namespace import", () => {
    expect(
      differentialModules({
        "main.tera": `import mathlib\n${hot("mathlib.square(i)")}`,
        "mathlib.tera": "fn square(n: int) -> int:\n  return n * n\n",
      }),
    ).toBe(21253400);
  });

  it("chains calls through three modules", () => {
    expect(
      differentialModules({
        "main.tera": `from a import outer\n${hot("outer(i)")}`,
        "a.tera": "from b import inner\nfn outer(n: int) -> int:\n  return inner(n) + 1\n",
        "b.tera": "fn inner(n: int) -> int:\n  return n * 2\n",
      }),
    ).toBe(160000);
  });

  it("uses a class defined in another module", () => {
    expect(
      differentialModules({
        "main.tera": `from shapes import Box\n${hot("Box(i).value()")}`,
        "shapes.tera": src(
          "class Box:",
          "  public constructor(v: int):",
          "    this.v = v",
          "  public value() -> int:",
          "    return this.v",
          "",
        ),
      }),
    ).toBe(79800);
  });

  it("keeps module-private state consistent across tiers", () => {
    expect(
      differentialModules({
        "main.tera": src(
          "from counter import bump",
          "i = 0",
          "while (i < 500):",
          "  bump()",
          "  i = (i + 1)",
          "bump()",
          "",
        ),
        "counter.tera": src(
          "_current = 0",
          "fn bump() -> int:",
          "  _current = _current + 1",
          "  return _current",
          "",
        ),
      }),
    ).toBe(501);
  });

  it("runs a package with a relative import", () => {
    expect(
      differentialModules({
        "main.tera": `from pkg.one import scale\n${hot("scale(i)")}`,
        "pkg/one.tera": "from .two import base\nfn scale(n: int) -> int:\n  return n * base\n",
        "pkg/two.tera": "base = 2\n",
      }),
    ).toBe(159600);
  });

  it("runs a re-export through a package __init__", () => {
    expect(
      differentialModules({
        "main.tera": `from pkg import scale\n${hot("scale(i)")}`,
        "pkg/__init__.tera": "from .impl import scale\n",
        "pkg/impl.tera": "fn scale(n: int) -> int:\n  return n * 4\n",
      }),
    ).toBe(319200);
  });

  it("runs mutually recursive functions across an import cycle", () => {
    expect(
      differentialModules({
        "main.tera": src(
          "from even import is_even",
          "count = 0",
          "i = 0",
          "while (i < 300):",
          "  if is_even(i):",
          "    count = (count + 1)",
          "  i = (i + 1)",
          "count",
          "",
        ),
        "even.tera": src(
          "from odd import is_odd",
          "fn is_even(n: int) -> bool:",
          "  if n == 0:",
          "    return true",
          "  return is_odd(n - 1)",
          "",
        ),
        "odd.tera": src(
          "from even import is_even",
          "fn is_odd(n: int) -> bool:",
          "  if n == 0:",
          "    return false",
          "  return is_even(n - 1)",
          "",
        ),
      }),
    ).toBe(150);
  });

  it("keeps two modules with the same function name apart", () => {
    expect(
      differentialModules({
        "main.tera": `from a import helper as ah\nfrom b import helper as bh\n${hot("(ah(i) + bh(i))")}`,
        "a.tera": "fn helper(n: int) -> int:\n  return n + 1\n",
        "b.tera": "fn helper(n: int) -> int:\n  return n * 2\n",
      }),
    ).toBe(239800);
  });

  it("mixes imported and local names in the same hot function", () => {
    expect(
      differentialModules({
        "main.tera": src(
          "from mathlib import square",
          "offset = 5",
          "fn work(n: int) -> int:",
          "  acc = 0",
          "  i = 0",
          "  while (i < n):",
          "    local = (i + offset)",
          "    acc = (acc + square(local))",
          "    i = (i + 1)",
          "  return acc",
          "total = 0",
          "r = 0",
          "while (r < 12):",
          "  total = work(400)",
          "  r = (r + 1)",
          "total",
          "",
        ),
        "mathlib.tera": "fn square(n: int) -> int:\n  return n * n\n",
      }),
    ).toBe(22061400);
  });
});

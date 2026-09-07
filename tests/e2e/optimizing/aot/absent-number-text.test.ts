import { describe } from "vitest";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const DRAINED = src("fn render(q: int[]) -> string:", "  v = q.shift()");

const RENDERED: readonly (readonly [string, string])[] = [
  [
    "spells out an integer a drain did not find",
    src(DRAINED, '  return "[" + v + "]"', "print(render([]))"),
  ],
  [
    "spells out an integer a drain did not find inside an interpolation",
    src(DRAINED, "  return `[${v}]`", "print(render([]))"),
  ],
  [
    "keeps rendering the integer a drain did find",
    src(DRAINED, '  return "[" + v + "]"', "print(render([7]))", "print(render([]))"),
  ],
  [
    "spells out the null a declared return admits",
    src(
      "fn pick(n: int) -> int | null:",
      "  if n > 0:",
      "    return n",
      "  return null",
      "fn show(n: int) -> string:",
      '  return "[" + pick(n) + "]"',
      "print(show(0))",
      "print(show(5))",
    ),
  ],
  [
    "spells out the undefined a declared return admits",
    src(
      "fn pick(n: int) -> int | undefined:",
      "  if n > 0:",
      "    return n",
      "  return undefined",
      "fn show(n: int) -> string:",
      "  return `${pick(n)}`",
      "print(show(0))",
      "print(show(5))",
    ),
  ],
  [
    "spells out an absent element read out of an array",
    src(
      "xs: (int | null)[] = [1, null, 3]",
      "i = 0",
      "while i < xs.length:",
      '  print("v=" + xs[i])',
      "  i = i + 1",
    ),
  ],
  [
    "spells out a float a drain did not find",
    src("fn render(q: float[]) -> string:", "  v = q.shift()", '  return "[" + v + "]"', "print(render([]))"),
  ],
];

describe("AOT rendering a number that may be absent", () => {
  for (const [name, source] of RENDERED) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
  }

  itNative(
    "spells out an integer a drain did not find through the C backend",
    native.agrees(src(DRAINED, '  return "[" + v + "]"', "print(render([]))")),
  );

  itNative(
    "keeps rendering the integer a drain did find through the C backend",
    native.agrees(src(DRAINED, '  return "[" + v + "]"', "print(render([7]))")),
  );
});

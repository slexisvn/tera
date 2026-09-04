import { describe, expect, it } from "vitest";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, image, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const DRAINS: readonly (readonly [string, string])[] = [
  ["answers undefined for a pop that found nothing", src("xs: int[] = []", "print(xs.pop())")],
  ["answers undefined for a shift that found nothing", src("xs: int[] = []", "print(xs.shift())")],
  [
    "answers undefined only after the last element is taken",
    src("xs: int[] = [1, 2]", "print(xs.pop())", "print(xs.pop())", "print(xs.pop())"),
  ],
  [
    "leaves the length at zero when a pop found nothing",
    src("xs: int[] = []", "print(xs.pop())", "print(xs.length)"),
  ],
  [
    "leaves the length at zero when a shift found nothing",
    src("xs: int[] = []", "print(xs.shift())", "print(xs.length)"),
  ],
  [
    "answers undefined for a float array too",
    src("xs: float[] = [1.5]", "print(xs.pop())", "print(xs.pop())"),
  ],
  [
    "keeps a guarded drain answering every element",
    src(
      "xs: int[] = [1, 2, 3]",
      "total: int = 0",
      "while xs.length > 0:",
      "  total = total + xs.pop()",
      "print(total)",
    ),
  ],
  [
    "keeps a shift-driven queue answering every element",
    src(
      "q: int[] = [0]",
      "seen: int[] = []",
      "while q.length > 0:",
      "  n = q.shift()",
      "  seen.push(n)",
      "  if n < 3:",
      "    q.push(n + 1)",
      "print(seen.join(\",\"))",
    ),
  ],
  [
    "shifts the remaining elements down after answering",
    src("xs: int[] = [1, 2, 3]", "print(xs.shift())", "print(xs.join(\",\"))"),
  ],
  [
    "compares what a drained pop answered against null",
    src("xs: int[] = []", "v = xs.pop()", "print(v == null)"),
  ],
];

describe("AOT draining an array", () => {
  for (const [name, source] of DRAINS) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
  }

  itNative(
    "answers undefined for an empty pop through the C backend",
    native.agrees(src("xs: int[] = []", "print(xs.pop())")),
  );

  itNative(
    "answers undefined for an empty shift through the C backend",
    native.agrees(src("xs: int[] = []", "print(xs.shift())")),
  );

  itRunsPe("faults instead of answering when the elements are not numbers", () => {
    const run = runPe(image(src('xs: string[] = ["a"]', "print(xs.pop())", "print(xs.pop())")));

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("cannot pop an empty array");
  });
});

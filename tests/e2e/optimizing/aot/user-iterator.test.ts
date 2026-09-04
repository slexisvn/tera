import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cBatch, cSource, itNative } from "../../../helpers/c-executor.js";
import { interpreted } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const batch = cBatch();

const RANGER = src(
  "class Ranger:",
  "  public constructor(start: int, stop: int):",
  "    this.current = start",
  "    this.stop = stop",
  '    this["@@iterator"] = () => this',
  "  public next() -> { done: bool, value: int | null }:",
  "    if this.current >= this.stop:",
  "      return { done: true, value: null }",
  "    held = this.current",
  "    this.current += 1",
  "    return { done: false, value: held }",
);

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  expect(runPe(image(source)).stdout).toBe(interpreted(source));
}

const WALKS: readonly (readonly [string, string])[] = [
  [
    "walks a class that answers steps",
    src(RANGER, "out: int[] = []", "for held of Ranger(1, 4):", "  out.push(held)", 'print(out.join(","))'),
  ],
  [
    "adds up what the steps answered",
    src(RANGER, "total: int = 0", "for held of Ranger(1, 5):", "  total = total + held", "print(total)"),
  ],
  [
    "walks a class that answers no steps at all",
    src(RANGER, "out: int[] = []", "for held of Ranger(3, 3):", "  out.push(held)", "print(out.length)"),
  ],
  [
    "walks two of them in turn",
    src(
      RANGER,
      "total: int = 0",
      "for held of Ranger(1, 3):",
      "  total = total + held",
      "for held of Ranger(1, 4):",
      "  total = total + held",
      "print(total)",
    ),
  ],
  [
    "leaves the walked object at its end",
    src(
      RANGER,
      "walker = Ranger(1, 3)",
      "for held of walker:",
      "  print(held)",
      "print(walker.current)",
    ),
  ],
];

describe("AOT for-of over a class that answers steps", () => {
  for (const [name, source] of WALKS) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
  }

  const WALKED = src(
    RANGER,
    "out: int[] = []",
    "for held of Ranger(1, 4):",
    "  out.push(held)",
    'print(out.join(","))',
  );
  const throughC = batch.program(() =>
    cSource(
      nodeEngine({ typecheck: "off" }).compileAot(`${WALKED}
`, {
        backend: "c",
        format: "assembly",
      }),
    ),
  );

  itNative("walks it the same way through the C backend", () => {
    expect(throughC().stdout).toBe(interpreted(WALKED));
  });

  it("leaves a class carrying no iterator hook alone, the way the interpreter refuses it", () => {
    const source = src(
      "class Stepper:",
      "  public constructor(a: int):",
      "    this.current = a",
      "  public next() -> { done: bool, value: int | null }:",
      "    return { done: true, value: null }",
      "for held of Stepper(1):",
      "  print(held)",
    );

    expect(() => interpreted(source)).toThrow(/not iterable/);
    expect(() => image(source)).toThrow(/IteratorInit/);
  });
});

import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

function program(source: string, backend = "x64-windows") {
  return nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend,
    format: backend === "c" ? "assembly" : "executable",
  });
}

function image(source: string): Uint8Array {
  const built = program(source);
  expect(built.skipped).toEqual([]);
  return built.files[0]!.contents as Uint8Array;
}

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(source);
  return stream.join("");
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function declineFor(source: string, backend = "c"): string {
  try {
    return program(source, backend)
      .skipped.map((entry) => entry.reason)
      .join("; ");
  } catch (error) {
    return (error as Error).message;
  }
}

const HALF = ["fn half(n: int) -> int:", "  return Math.trunc(n / 2)"];

const COUNTED = [
  "fn counted(n: int) -> int[]:",
  "  out: int[] = []",
  "  i: int = 0",
  "  while i < n:",
  "    out.push(i + 1)",
  "    i = i + 1",
  "  return out",
];

const TOTAL = [
  "fn total(ys: float[]) -> float:",
  "  acc: float = 0.0",
  "  i: int = 0",
  "  while i < ys.length:",
  "    acc = acc + ys[i]",
  "    i = i + 1",
  "  return acc",
];

const INTO_RETURNED_ARRAY = src(
  ...HALF,
  "fn halves(n: int) -> int[]:",
  "  out: int[] = []",
  "  out.push(half(n))",
  "  out.push(half(n + 1))",
  "  return out",
  `print(halves(7).join("|"))`,
);

const INTO_PASSED_ARRAY = src(...TOTAL, ...COUNTED, "print(total(counted(3)))");

const INTO_DECLARED_FIELD = src(
  "type Bag = { counts: int[] }",
  ...HALF,
  "fn filled(n: int) -> Bag:",
  "  out: int[] = []",
  "  out.push(half(n))",
  "  out.push(half(n + 2))",
  "  bag: Bag = { counts: out }",
  "  return bag",
  `print(filled(7).counts.join("|"))`,
);

const ACROSS_A_CALL_IT_CANNOT_RESHAPE = src(
  "fn make(n: int) -> int[]:",
  "  if n <= 0:",
  "    seed: int[] = []",
  "    return seed",
  "  held: int[] = make(n - 1)",
  "  held.push(n)",
  "  return held",
  "fn walk(ys: float[], at: int) -> float:",
  "  if at >= ys.length:",
  "    return 0.0",
  "  return ys[at] + walk(ys, at + 1)",
  "print(walk(make(3), 0))",
);

describe("AOT array element layout", () => {
  it("compiles an int[] that a float-typed int is pushed into", () => {
    expect(program(INTO_RETURNED_ARRAY, "c").skipped).toEqual([]);
  });

  itRunsPe("reads back the ints pushed into an int[] the caller receives", () => {
    agrees(INTO_RETURNED_ARRAY);
  });

  itRunsPe("lays the array out for the float[] parameter it is handed to", () => {
    agrees(INTO_PASSED_ARRAY);
  });

  itRunsPe("lays the array out for the int[] field it is stored in", () => {
    agrees(INTO_DECLARED_FIELD);
  });

  itRunsPe("lays a string array out from the field the program pushes into it", () => {
    agrees(
      src(
        "class Item:",
        "  public constructor(name: string, count: int):",
        "    this.name = name",
        "    this.count = count",
        "items: Item[] = []",
        'items.push(Item("bolt", 12))',
        'items.push(Item("nut", 3))',
        "names: string[] = []",
        "for item of items:",
        "  if item.count < 10:",
        "    names.push(item.name)",
        "print(names.length)",
        "print(names[0])",
      ),
    );
  });

  it("stops on an int[] handed to a float[] parameter it cannot lay out again", () => {
    expect(declineFor(ACROSS_A_CALL_IT_CANNOT_RESHAPE)).toContain(
      "passes an array of int where float[] is declared",
    );
  });
});

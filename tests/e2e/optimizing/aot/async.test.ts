import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { AotLinkError } from "../../../../src/optimizing/drivers/aot.js";

const src = (...lines: string[]) => lines.join("\n");

const BODY = src(
  "async fn g() -> int:",
  "  return 1",
  "async fn f() -> int:",
  '  print("a")',
  "  x = await g()",
  '  print("b")',
  "  return x",
);

const SUSPENDS = src(BODY, "p = f()", 'print("c")', "print(await p)");
const IMMEDIATE = src(BODY, "print(await f())");

function printedBy(source: string): readonly string[] {
  const printed: string[] = [];
  nodeEngine({ typecheck: "off", output: (line) => printed.push(line) }).runNative(
    `${source}\n`,
  );
  return printed;
}

function compiled(source: string) {
  return nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
}

function declined(source: string): string {
  try {
    const program = compiled(source);
    return program.skipped.map((entry) => entry.reason).join("; ");
  } catch (error) {
    if (error instanceof AotLinkError) return error.message;
    throw error;
  }
}

const ELIDED: ReadonlyArray<readonly [string, string]> = [
  [
    "await in a loop",
    src(
      "async fn step(n: int) -> int:",
      "  return n + 1",
      "async fn run(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + await step(i)",
      "    i = i + 1",
      "  return total",
      "print(await run(5))",
    ),
  ],
  [
    "await in a branch",
    src(
      "async fn a() -> int:",
      "  return 1",
      "async fn b() -> int:",
      "  return 2",
      "async fn pick(n: int) -> int:",
      "  if n > 0:",
      "    return await a()",
      "  return await b()",
      "print(await pick(1))",
    ),
  ],
  [
    "awaits chained through async callees",
    src(
      "async fn inner() -> int:",
      "  return 3",
      "async fn middle() -> int:",
      "  return await inner()",
      "async fn outer() -> int:",
      "  return await middle()",
      "print(await outer())",
    ),
  ],
  [
    "an async call carrying arguments",
    src("async fn add(a: int, b: int) -> int:", "  return a + b", "print(await add(2, 3))"),
  ],
];

describe("AOT async", () => {
  it("interleaves a suspending call the way the coroutine split has to reproduce", () => {
    expect(printedBy(SUSPENDS)).toEqual(["a", "c", "b", "1"]);
  });

  it("runs the immediately awaited shape without interleaving", () => {
    expect(printedBy(IMMEDIATE)).toEqual(["a", "b", "1"]);
  });

  itRunsPe("splits the shape whose promise outlives the call that made it", () => {
    const program = compiled(SUSPENDS);
    expect(program.skipped).toEqual([]);

    const run = runPe(program.files[0]!.contents as Uint8Array);
    expect([run.status, run.stdout]).toEqual([0, `${printedBy(SUSPENDS).join("\n")}\n`]);
  });

  itRunsPe("keeps a suspended frame alive across a collection", () => {
    const source = src(
      "class Cell:",
      "  public constructor(v: int):",
      "    this.v = v",
      "fn churn(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + Cell(i % 7).v",
      "    i = i + 1",
      "  return total",
      BODY,
      "p = f()",
      "print(churn(300000))",
      "print(await p)",
    );
    const program = compiled(source);
    expect(program.skipped).toEqual([]);

    const run = runPe(program.files[0]!.contents as Uint8Array);
    expect([run.status, run.stdout]).toEqual([0, `${printedBy(source).join("\n")}\n`]);
  });

  itRunsPe("compiles the immediately awaited shape with no promise at all", () => {
    const program = compiled(IMMEDIATE);
    expect(program.skipped).toEqual([]);

    const run = runPe(program.files[0]!.contents as Uint8Array);
    expect([run.status, run.stdout]).toEqual([0, `${printedBy(IMMEDIATE).join("\n")}\n`]);
  });

  for (const [shape, source] of ELIDED) {
    itRunsPe(`prints what the interpreter prints for ${shape}`, () => {
      const program = compiled(source);
      expect([shape, program.skipped]).toEqual([shape, []]);

      const run = runPe(program.files[0]!.contents as Uint8Array);
      expect([shape, run.status, run.stdout]).toEqual([
        shape,
        0,
        `${printedBy(source).join("\n")}\n`,
      ]);
    });
  }
});

describe("AOT coroutine dispatch", () => {
  it("resumes a frame through the routine it carries rather than a comparison chain", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(`${SUSPENDS}
`, {
      backend: "c",
      format: "assembly",
    });
    const source = String(program.files.find((file) => file.name.endsWith(".c"))!.contents);

    expect(program.skipped).toEqual([]);
    expect(source).not.toContain("tera_dispatch");
    expect(source).toMatch(/tera_drain[\s\S]*\(\(int32_t \(\*\)\(unsigned char \*\)\)/);
  });
});

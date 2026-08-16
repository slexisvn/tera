import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

const LEAF = src("async fn leaf(id: int) -> int:", "  return id");

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

// Every await costs one turn of the microtask queue, so a chain that awaits through
// a deeper callee finishes later than a shallow one started after it. Flattening an
// always-awaited callee into a plain call loses a turn and reorders the output.
const INTERLEAVINGS: ReadonlyArray<readonly [string, string]> = [
  [
    "two chains where one awaits through a deeper callee",
    src(
      LEAF,
      "async fn mid(id: int) -> int:",
      "  v: int = await leaf(id)",
      "  return v + 10",
      "async fn a() -> int:",
      "  x: int = await mid(1)",
      '  print("a", x)',
      "  return x",
      "async fn b() -> int:",
      "  y: int = await leaf(2)",
      '  print("b", y)',
      "  return y",
      "a()",
      "b()",
    ),
  ],
  [
    "three chains of three different depths",
    src(
      LEAF,
      "async fn d1(id: int) -> int:",
      "  return await leaf(id)",
      "async fn d2(id: int) -> int:",
      "  return await d1(id)",
      "async fn d3(id: int) -> int:",
      "  return await d2(id)",
      "async fn a() -> int:",
      "  x: int = await d3(1)",
      '  print("a", x)',
      "  return x",
      "async fn b() -> int:",
      "  y: int = await d1(2)",
      '  print("b", y)',
      "  return y",
      "async fn c() -> int:",
      "  z: int = await d2(3)",
      '  print("c", z)',
      "  return z",
      "a()",
      "b()",
      "c()",
    ),
  ],
  [
    "two chains taking turns inside a loop",
    src(
      LEAF,
      "async fn a() -> int:",
      "  total: int = 0",
      "  for n of [1, 2, 3]:",
      "    total += await leaf(n)",
      '    print("a", total)',
      "  return total",
      "async fn b() -> int:",
      "  total: int = 0",
      "  for n of [10, 20]:",
      "    total += await leaf(n)",
      '    print("b", total)',
      "  return total",
      "a()",
      "b()",
    ),
  ],
  [
    "a chain that rejects while another is still running",
    src(
      LEAF,
      "async fn bad() -> int:",
      "  v: int = await leaf(1)",
      '  throw "boom"',
      "  return v",
      "async fn a() -> int:",
      "  try:",
      "    x: int = await bad()",
      '    print("a", x)',
      "  catch e:",
      '    print("caught", e)',
      "  return 0",
      "async fn b() -> int:",
      "  y: int = await leaf(2)",
      '  print("b", y)',
      "  return y",
      "a()",
      "b()",
    ),
  ],
  [
    "one callee awaited by two chains",
    src(
      LEAF,
      "async fn mid(id: int) -> int:",
      "  v: int = await leaf(id)",
      "  return v + 100",
      "async fn a() -> int:",
      "  x: int = await mid(1)",
      '  print("a", x)',
      "  x = await mid(2)",
      '  print("a2", x)',
      "  return x",
      "async fn b() -> int:",
      "  y: int = await mid(3)",
      '  print("b", y)',
      "  return y",
      "a()",
      "b()",
    ),
  ],
  [
    "a string chain interleaved with a numeric one",
    src(
      "async fn text(id: int) -> string:",
      "  return `v${id}`",
      "async fn wrap(id: int) -> string:",
      "  s: string = await text(id)",
      '  return s + "!"',
      "async fn a() -> int:",
      "  s: string = await wrap(1)",
      '  print("a", s)',
      "  return 0",
      "async fn b() -> int:",
      "  s: string = await text(2)",
      '  print("b", s)',
      "  return 0",
      "a()",
      "b()",
    ),
  ],
  [
    "an async method chain beside a shallower one",
    src(
      "class Svc:",
      "  public constructor(base: int):",
      "    this.base = base",
      "  public async one(id: int) -> int:",
      "    return this.base + id",
      "  public async two(id: int) -> int:",
      "    v: int = await this.one(id)",
      "    return v * 2",
      "async fn a() -> int:",
      "  s = Svc(10)",
      "  x: int = await s.two(1)",
      '  print("a", x)',
      "  return x",
      "async fn b() -> int:",
      "  s = Svc(20)",
      "  y: int = await s.one(2)",
      '  print("b", y)',
      "  return y",
      "a()",
      "b()",
    ),
  ],
  [
    "a callee that only suspends on one branch",
    src(
      LEAF,
      "async fn pick(n: int) -> int:",
      "  if n > 1:",
      "    return await leaf(n)",
      "  return n",
      "async fn a() -> int:",
      "  x: int = await pick(5)",
      '  print("a", x)',
      "  return x",
      "async fn b() -> int:",
      "  y: int = await pick(0)",
      '  print("b", y)',
      "  return y",
      "a()",
      "b()",
    ),
  ],
  [
    "four chains started back to back",
    src(
      LEAF,
      "async fn mid(id: int) -> int:",
      "  return await leaf(id)",
      "async fn one() -> int:",
      "  v: int = await mid(1)",
      '  print("one", v)',
      "  return v",
      "async fn two() -> int:",
      "  v: int = await leaf(2)",
      '  print("two", v)',
      "  return v",
      "async fn three() -> int:",
      "  v: int = await mid(3)",
      '  print("three", v)',
      "  return v",
      "async fn four() -> int:",
      "  v: int = await leaf(4)",
      '  print("four", v)',
      "  return v",
      "one()",
      "two()",
      "three()",
      "four()",
    ),
  ],
  [
    "a chain that returns nothing beside one that returns a value",
    src(
      LEAF,
      "async fn mid(id: int) -> int:",
      "  return await leaf(id)",
      "async fn a() -> void:",
      "  x: int = await mid(1)",
      '  print("a", x)',
      "async fn b() -> void:",
      "  y: int = await leaf(2)",
      '  print("b", y)',
      "a()",
      "b()",
    ),
  ],
];

describe("AOT coroutines take the same turns as the interpreter", () => {
  for (const [shape, source] of INTERLEAVINGS) {
    itRunsPe(`prints in the interpreter's order for ${shape}`, () => {
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

  it("keeps a callee that awaits as a coroutine of its own", () => {
    const program = compiled(
      src(
        LEAF,
        "async fn mid(id: int) -> int:",
        "  return await leaf(id)",
        "async fn a() -> int:",
        "  return await mid(1)",
        "a()",
      ),
    );
    const names = program.compiled.map((fn) => fn.name);
    expect(names).toContain("mid$resume");
  });
});

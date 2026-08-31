import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

const DOUBLE = src("async fn d(n: int) -> int:", "  return n * 2");
const BOOM = src(
  "async fn boom(n: int) -> int:",
  "  if n > 0:",
  '    throw "bad"',
  "  return n",
);

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
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  return program.skipped.map((entry) => entry.reason).join("; ");
}

// The promise surface is rewritten into ordinary async functions, so what these check
// is that the rewrite settles the same values in the same order as the interpreter.
const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["Promise.resolve handed to then", 'Promise.resolve(42).then(v => print("resolved", v))'],
  [
    "a chain of three thens",
    'Promise.resolve(10).then(v => v * 2).then(v => v + 1).then(v => print("chained", v))',
  ],
  ["then on an async function", src(DOUBLE, 'd(21).then(v => print("v", v))')],
  [
    "an awaited then",
    src(
      DOUBLE,
      "async fn m() -> void:",
      "  v: int = await d(5).then(x => x + 1)",
      '  print("v", v)',
      "m()",
    ),
  ],
  [
    "a promise kept in a variable",
    src("p = Promise.resolve(42)", 'p.then(v => print("resolved", v))'),
  ],
  ["catch on a rejection", src(BOOM, 'boom(1).catch(e => print("caught:", e))')],
  [
    "an awaited catch that recovers",
    src(
      BOOM,
      "async fn m() -> void:",
      "  v: int = await boom(1).catch(e => -1)",
      '  print("v", v)',
      "m()",
    ),
  ],
  [
    "an awaited catch nothing throws into",
    src(
      BOOM,
      "async fn m() -> void:",
      "  v: int = await boom(0).catch(e => -1)",
      '  print("v", v)',
      "m()",
    ),
  ],
  [
    "Promise.all over three calls",
    src(
      DOUBLE,
      "async fn m() -> void:",
      "  rs = await Promise.all([d(1), d(2), d(3)])",
      '  print("all", rs[0], rs[1], rs[2])',
      "m()",
    ),
  ],
  [
    "Promise.all beside another chain",
    src(
      DOUBLE,
      "async fn m() -> void:",
      "  rs = await Promise.all([d(1), d(2)])",
      '  print("m", rs[0] + rs[1])',
      "async fn other() -> void:",
      "  v: int = await d(10)",
      '  print("other", v)',
      "m()",
      "other()",
    ),
  ],
  [
    "a then beside an await chain",
    src(
      DOUBLE,
      "async fn m() -> void:",
      "  v: int = await d(9)",
      '  print("m", v)',
      'd(1).then(v => print("t", v))',
      "m()",
    ),
  ],
  [
    "a chain interleaved with an async function",
    src(
      DOUBLE,
      "async fn m() -> void:",
      "  v: int = await d(4)",
      '  print("m", v)',
      'Promise.resolve(1).then(v => v + 1).then(v => print("chain", v))',
      "m()",
    ),
  ],
  [
    "a rejection travelling through the promise takes its turn",
    src(
      "async fn half(n: float) -> float:",
      "  if n < 0.0:",
      '    throw "neg"',
      "  return n / 2.0",
      "async fn one() -> void:",
      "  try:",
      "    a: float = await half(4.0)",
      '    print("a", a)',
      "    b: float = await half(-1.0)",
      '    print("b", b)',
      "  catch e:",
      '    print("caught", e)',
      "async fn two() -> void:",
      "  c: float = await half(8.0)",
      '  print("c", c)',
      "one()",
      "two()",
    ),
  ],
];

describe("AOT promise surface", () => {
  for (const [shape, source] of SHAPES) {
    itRunsPe(`settles like the interpreter for ${shape}`, () => {
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

  it("rewrites the surface into async functions rather than a promise object", () => {
    const program = compiled('Promise.resolve(1).then(v => print("v", v))');
    const names = program.compiled.map((fn) => fn.name);
    expect(names.some((name) => name.startsWith("tera_promise$resolve"))).toBe(true);
    expect(names.some((name) => name.startsWith("tera_promise$then"))).toBe(true);
  });

  it("declines a then on a catch that hands back nothing", () => {
    expect(
      declined(src(DOUBLE, 'd(3).catch(e => print("nope", e)).then(v => print("v", v))')),
    ).not.toBe("");
  });

  itRunsPe("catches rejections from two different functions at once", () => {
    const source = src(
      BOOM,
      "async fn m() -> void:",
      "  a: int = await boom(1).catch(e => -1)",
      "  b: int = await boom(2).catch(e => -2)",
      '  print("v", a, b)',
      "m()",
    );
    const program = compiled(source);
    expect(program.skipped).toEqual([]);

    const run = runPe(program.files[0]!.contents as Uint8Array);
    expect([run.status, run.stdout]).toEqual([0, `${printedBy(source).join("\n")}\n`]);
  });
});

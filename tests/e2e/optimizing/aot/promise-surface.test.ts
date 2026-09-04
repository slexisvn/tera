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

describe("AOT Promise.reject", () => {
  const REJECTS: readonly (readonly [string, string])[] = [
    [
      "a rejection a catch turns back into a value",
      src('Promise.reject("boom")', '  .catch(e => `caught: ${e}`)', "  .then(v => print(v))"),
    ],
    [
      "a rejection a catch only prints",
      src('Promise.reject("boom")', "  .catch(e => print(`caught: ${e}`))"),
    ],
    [
      "a rejection an await hands to a catch block",
      src(
        "async fn run() -> void:",
        "  try:",
        '    await Promise.reject("boom")',
        "  catch failure:",
        "    print(`caught: ${failure}`)",
        "run()",
      ),
    ],
  ];

  for (const [shape, source] of REJECTS) {
    itRunsPe(`settles like the interpreter for ${shape}`, () => {
      const program = compiled(source);
      const run = runPe(program.files[0]!.contents as Uint8Array);

      expect([shape, run.status, run.stdout]).toEqual([
        shape,
        0,
        `${printedBy(source).join("\n")}\n`,
      ]);
    });
  }

  itRunsPe("hands a rejection past a then rather than running its callback", () => {
    const source = src(
      'Promise.reject("boom")',
      '  .then(v => print("unreachable", v))',
      '  .catch(e => print("chain caught:", e))',
    );
    const program = compiled(source);
    const run = runPe(program.files[0]!.contents as Uint8Array);

    expect(run.stdout).not.toContain("unreachable");
    expect([run.status, run.stdout]).toEqual([0, `${printedBy(source).join("\n")}\n`]);
  });

  itRunsPe("hands a thrown rejection past a then as well", () => {
    const source = src(
      BOOM,
      "boom(1)",
      '  .then(v => print("unreachable", v))',
      '  .catch(e => print("caught:", e))',
    );
    const program = compiled(source);
    const run = runPe(program.files[0]!.contents as Uint8Array);

    expect(run.stdout).not.toContain("unreachable");
    expect([run.status, run.stdout]).toEqual([0, `${printedBy(source).join("\n")}\n`]);
  });

  itRunsPe("keeps two rejections apart rather than letting one overwrite the other", () => {
    const source = src(
      'Promise.reject("first").catch(e => print("a", e))',
      'Promise.reject("second").catch(e => print("b", e))',
    );
    const program = compiled(source);
    const run = runPe(program.files[0]!.contents as Uint8Array);

    expect([run.status, run.stdout]).toEqual([0, `${printedBy(source).join("\n")}\n`]);
  });

  itRunsPe("settles a rejected chain beside a resolved one in the interpreter's order", () => {
    const source = src(
      "Promise.resolve(80)",
      "  .then(v => v / 2)",
      "  .then(v => `half is ${v}`)",
      "  .then(v => print(v))",
      'Promise.reject("nope")',
      '  .then(v => print("unreachable", v))',
      '  .catch(e => print("caught", e))',
    );
    const program = compiled(source);
    const run = runPe(program.files[0]!.contents as Uint8Array);

    expect(run.stdout).not.toContain("unreachable");
    expect([run.status, run.stdout]).toEqual([0, `${printedBy(source).join("\n")}\n`]);
  });

  it("rewrites a rejection into an async function of its own", () => {
    const program = compiled(src('Promise.reject("boom")', "  .catch(e => print(e))"));
    const names = program.compiled.map((fn) => fn.name);

    expect(names.some((name) => name.startsWith("tera_promise$reject"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { cCalls } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const BACKEND = "x64-windows";

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: BACKEND,
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function assemblyOf(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: BACKEND,
    format: "assembly",
  });
  expect(program.skipped).toEqual([]);
  return program.files.find((file) => file.name.endsWith(".s"))!.contents as string;
}

const native = cCalls({
  toC: (source: string) => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}
`);
    expect(program.skipped).toEqual([]);
    return cSource(program);
  },
  interpret: (source: string, call: string) =>
    nodeEngine({ typecheck: "off" }).runNative(`${source}
${call}
`),
});

function bodyOf(assembly: string, name: string): string {
  const start = assembly.indexOf(`${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = assembly.slice(start);
  const end = body.indexOf(".cfi_endproc");
  return end < 0 ? body : body.slice(0, end);
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

const COUNTDOWN = src(
  "fn countdown(n: int, acc: int) -> int:",
  "  if n <= 0:",
  "    return acc",
  "  return countdown(n - 1, acc + n)",
);

const PARITY = src(
  "fn odd(n: int, flag: int) -> int:",
  "  if n == 0:",
  "    return flag",
  "  return odd(n - 1, 1 - flag)",
);

describe("AOT self tail calls", () => {
  itRunsPe("answers what the interpreter answers at a depth both can reach", () => {
    agrees(src(COUNTDOWN, "print(countdown(800, 0))"));
    agrees(src(PARITY, "print(odd(801, 0))"));
  });

  itRunsPe("runs a recursion deeper than any stack could hold", () => {
    const run = runPe(image(src(COUNTDOWN, "print(countdown(1000000, 0))")));

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("1784293664");
  });

  itRunsPe("rotates arguments that are themselves parameters", () => {
    agrees(
      src(
        "fn gcd(a: int, b: int) -> int:",
        "  if b == 0:",
        "    return a",
        "  return gcd(b, a % b)",
        "print(gcd(48, 18))",
        "print(gcd(1071, 462))",
      ),
    );
    agrees(
      src(
        "fn spin(a: int, b: int, c: int) -> int:",
        "  if c == 0:",
        "    return a * 100 + b",
        "  return spin(b, a + 1, c - 1)",
        "print(spin(1, 2, 3))",
      ),
    );
  });

  itRunsPe("keeps a tail call that answers through a class instance correct", () => {
    agrees(
      src(
        "class Box:",
        "  public constructor(total: int):",
        "    this.total = total",
        "  public read() -> int:",
        "    return this.total",
        "fn fold(n: int, held: Box) -> Box:",
        "  if n <= 0:",
        "    return held",
        "  return fold(n - 1, Box(held.read() + n))",
        "print(fold(200, Box(0)).read())",
      ),
    );
  });

  itNative("answers the same through the C backend", native.matches(COUNTDOWN, "countdown", [800, 0]));

  it("leaves no call to itself in the code it emits", () => {
    const body = bodyOf(assemblyOf(src(COUNTDOWN, "print(countdown(3, 0))")), "countdown");

    expect(body).not.toContain("call countdown");
    expect(body).toMatch(/jmp \.Lcountdown_\d+/);
  });

  it("still calls a function that is not itself", () => {
    const body = bodyOf(
      assemblyOf(
        src(
          "fn step(n: int) -> int:",
          "  return n - 1",
          "fn walk(n: int, acc: int) -> int:",
          "  if n <= 0:",
          "    return acc",
          "  return walk(step(n), acc + n)",
          "print(walk(4, 0))",
        ),
      ),
      "walk",
    );

    expect(body).not.toContain("call walk");
  });

  it("tests a loop at the bottom so each turn costs one branch", () => {
    const body = bodyOf(
      assemblyOf(
        src(
          "fn total(n: int) -> int:",
          "  acc = 0",
          "  i = 0",
          "  while i < n:",
          "    acc = acc + i",
          "    i = i + 1",
          "  return acc",
          "print(total(4))",
        ),
      ),
      "total",
    );
    const lines = body.split("\n").map((line) => line.trim());
    const labelled = new Map(
      lines.flatMap((line, at) => (line.endsWith(":") ? [[line.slice(0, -1), at]] : [])),
    );
    const closing = lines.flatMap((line, at) => {
      const jump = /^(j\w+) (\.Ltotal_\d+)$/.exec(line);
      const target = jump === null ? undefined : labelled.get(jump[2]!);
      return target !== undefined && target < at && jump![1] !== "jmp" ? [target] : [];
    });

    expect(closing).toHaveLength(1);
    const turn = lines.slice(closing[0]! + 1, lines.findIndex((line, at) => at > closing[0]! && line.endsWith(":")));
    expect(turn.filter((line) => /^j\w+ /.test(line))).toEqual([]);
  });
});

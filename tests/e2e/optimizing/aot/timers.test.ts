import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCProgram } from "../../../helpers/c-executor.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { aotBackends } from "../../../../src/cli/targets.js";

const src = (...lines: string[]) => lines.join("\n");

const CLOCK_CALL = /=\s*tera_clock\(\)/;
const WAIT_CALL = /tera_pause\((?:\(double\))?v\d+\)/;

const TICKS = src(
  "async fn tick(n: int) -> int:",
  "  await sleep(10)",
  "  print(n)",
  "  return n",
  "p = tick(1)",
  "q = tick(2)",
  "print(await p + await q)",
);

const OUTLIVES = src(
  "async fn late() -> int:",
  "  await sleep(5)",
  '  print("ran")',
  "  return 0",
  "late()",
  'print("first")',
);

const OVERLAPS = src(
  "async fn nap(n: int) -> int:",
  "  await sleep(120)",
  "  return n",
  "a = nap(1)",
  "b = nap(2)",
  "c = nap(3)",
  "print(await a + await b + await c)",
);

const REJECTS = src(
  "async fn boom() -> int:",
  "  await sleep(5)",
  '  throw("late failure")',
  "  return 0",
  "boom()",
  'print("before")',
);

function printedBy(source: string): string {
  const printed: string[] = [];
  nodeEngine({ typecheck: "off", output: (line) => printed.push(line) }).runNative(
    `${source}\n`,
  );
  return printed.map((line) => `${line}\n`).join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function compiled(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
  });
  expect(program.skipped).toEqual([]);
  return cSource(program);
}

const CASES: readonly (readonly [string, string, string])[] = [
  ["wakes each parked frame once its deadline passes", TICKS, "1\n2\n3\n"],
  ["keeps the program alive while a frame is still parked", OUTLIVES, "first\nran\n"],
  ["settles overlapping deadlines from one wait", OVERLAPS, "6\n"],
];

describe("AOT timers", () => {
  it("takes no wait set into a program that never sleeps", () => {
    const source = compiled(
      src(
        "async fn inner() -> int:",
        "  return 2",
        "async fn outer() -> int:",
        "  x = await inner()",
        "  return x + 1",
        "p = outer()",
        'print("c")',
        "print(await p)",
      ),
    );

    expect(source).toContain("tera_drain");
    expect(source).not.toContain("tera_wake");
    expect(source).not.toMatch(CLOCK_CALL);
  });

  it("gives a program that sleeps a wait set and a blocking step", () => {
    const source = compiled(TICKS);

    expect(source).toContain("tera_wake");
    expect(source).toMatch(CLOCK_CALL);
    expect(source).toMatch(WAIT_CALL);
  });

  it("refuses to sleep on a backend with no clock, and says why", () => {
    for (const backend of aotBackends()) {
      const model = backend.target;
      const program = nodeEngine({ typecheck: "off" }).compileAot(`${TICKS}\n`, {
        backend: backend.id,
      });
      if (model.capabilities.has("timers")) {
        expect([backend.id, program.skipped]).toEqual([backend.id, []]);
        continue;
      }
      const refusal = program.skipped.find((fn) => fn.reason.includes("sleep"));
      expect([backend.id, refusal === undefined]).toEqual([backend.id, false]);
      expect(refusal!.reason).toContain(backend.id);
    }
  });

  for (const [name, source, expected] of CASES) {
    it(`${name} when the interpreter runs it`, () => {
      expect(printedBy(source)).toBe(expected);
    });

    itNative(`${name} the way the interpreter does`, () => {
      expect(runCProgram(compiled(source)).stdout).toBe(printedBy(source));
    });

    itRunsPe(`${name} in a native binary`, () => {
      const run = runPe(image(source));

      expect([run.status, run.stdout]).toEqual([0, expected]);
    });
  }

  itRunsPe("reports a rejection that only escapes after a deadline", () => {
    const run = runPe(image(REJECTS));

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("before\n");
    expect(run.stderr.trim()).toBe("Uncaught (in promise) late failure");
  });
});

import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { itRunsElf, runElf } from "../../../helpers/elf-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function build(source: string, entry = "main", result?: "print" | "exit"): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend: "x64-linux",
    format: "executable",
    entry,
    result,
  });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  return program;
}

function imageOf(source: string, entry = "main", result?: "print" | "exit"): Uint8Array {
  const file = build(source, entry, result).files[0]!;
  return file.contents as Uint8Array;
}

function exitCodeOf(source: string, entry = "main"): number | null {
  return runElf(imageOf(source, entry)).status;
}

describe("x64 executables built without an external toolchain", () => {
  itRunsElf("exits with a computed constant", () => {
    expect(exitCodeOf(src("fn main() -> int:", "  return 7 + 35"))).toBe(42);
  });

  itRunsElf("runs a loop", () => {
    expect(
      exitCodeOf(
        src(
          "fn main() -> int:",
          "  total = 0",
          "  i = 1",
          "  while i <= 10:",
          "    total = total + i",
          "    i = i + 1",
          "  return total",
        ),
      ),
    ).toBe(55);
  });

  itRunsElf("calls another compiled function", () => {
    expect(
      exitCodeOf(
        src(
          "fn triple(n: int) -> int:",
          "  return n * 3",
          "fn main() -> int:",
          "  return triple(14)",
        ),
      ),
    ).toBe(42);
  });

  itRunsElf("uses the integer division runtime routine", () => {
    expect(
      exitCodeOf(src("fn main() -> int:", "  n = 100", "  return n % 7")),
    ).toBe(2);
  });

  itRunsElf("rounds without any libm dependency", () => {
    expect(
      exitCodeOf(src("fn main() -> int:", "  x = 41.7", "  return Math.floor(x)")),
    ).toBe(41);
  });

  itRunsElf("reads a character out of a string constant", () => {
    expect(
      exitCodeOf(src("fn main() -> int:", '  s = "A!"', "  return s.char_code_at(1)")),
    ).toBe(33);
  });

  itRunsElf("prints an integer result when asked to", () => {
    const run = runElf(imageOf(src("fn main() -> int:", "  return 6 * 7"), "main", "print"));

    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe("42");
  });

  itRunsElf("prints a string an entry built without reading input", () => {
    const run = runElf(imageOf(src("fn main() -> string:", '  return "Fe" + "2O3"')));

    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe("Fe2O3");
  });

  itRunsElf("reads an array element", () => {
    expect(
      exitCodeOf(
        src("fn main() -> int:", "  data = [10, 20, 30]", "  return data[1] + data[2]"),
      ),
    ).toBe(50);
  });
});

describe("x64 executable entry requirements", () => {
  it("makes the top level of the file the entry when none is named", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src("fn main() -> int:", "  return 1"),
      { backend: "x64-linux", format: "executable" },
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.name)).toContain("tera_program");
  });

  it("names the function it could not find", () => {
    expect(() => build(src("fn main() -> int:", "  return 1"), "missing")).toThrow(
      /no compiled function is named missing/,
    );
  });

  it("refuses an entry that takes parameters", () => {
    expect(() => build(src("fn main(n: int) -> int:", "  return n"))).toThrow(
      /takes no parameters; read what it needs with input\(\)/,
    );
  });

  it("refuses a float result it has no way to print", () => {
    expect(() => build(src("fn main() -> float:", "  return 1.5"))).toThrow(
      /returns float64, which this target cannot print/,
    );
  });

  it("refuses to make a string result the exit status", () => {
    expect(() =>
      build(src("fn main() -> string:", '  return "hi"'), "main", "exit"),
    ).toThrow(/cannot be an exit status/);
  });
});

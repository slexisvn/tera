import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import {
  TERA_HEAP_COMMIT_BYTES,
  TERA_STATICS,
} from "../../../../src/optimizing/target/runtime-layout.js";

const src = (...lines: string[]) => lines.join("\n");

function build(
  source: string,
  entry: string | null = "main",
  result?: "print" | "exit",
): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
    backend: "x64-windows",
    format: "executable",
    ...(entry === null ? {} : { entry }),
    result,
  });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  return program;
}

function imageOf(
  source: string,
  entry: string | null = "main",
  result?: "print" | "exit",
): Uint8Array {
  const file = build(source, entry, result).files[0]!;
  return file.contents as Uint8Array;
}

function exitCodeOf(source: string, entry: string | null = "main"): number | null {
  return runPe(imageOf(source, entry)).status;
}

describe("x64 windows executables built without an external toolchain", () => {
  itRunsPe("exits with a computed constant", () => {
    expect(exitCodeOf(src("fn main() -> int:", "  return 7 + 35"))).toBe(42);
  });

  itRunsPe("runs a loop", () => {
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

  itRunsPe("calls another compiled function", () => {
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

  itRunsPe("uses the integer division runtime routine", () => {
    expect(exitCodeOf(src("fn main() -> int:", "  n = 100", "  return n % 7"))).toBe(2);
  });

  itRunsPe("rounds without any libm dependency", () => {
    expect(exitCodeOf(src("fn main() -> int:", "  x = 41.7", "  return Math.floor(x)"))).toBe(
      41,
    );
  });

  itRunsPe("reads a character out of a string constant", () => {
    expect(
      exitCodeOf(src("fn main() -> int:", '  s = "A!"', "  return s.char_code_at(1)")),
    ).toBe(33);
  });

  itRunsPe("reads an array element", () => {
    expect(
      exitCodeOf(
        src("fn main() -> int:", "  data = [10, 20, 30]", "  return data[1] + data[2]"),
      ),
    ).toBe(50);
  });

  itRunsPe("prints an integer result when asked to", () => {
    const run = runPe(imageOf(src("fn main() -> int:", "  return 6 * 7"), "main", "print"));

    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe("42");
  });

  itRunsPe("prints a string an entry built without reading input", () => {
    const run = runPe(imageOf(src("fn main() -> string:", '  return "Fe" + "2O3"')));

    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd()).toBe("Fe2O3");
  });

  itRunsPe("echoes text through kernel32 file handles", () => {
    const image = imageOf(src('line = input("say: ")', "print(line + line)"), null);

    const run = runPe(image, "ab\n");

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("say: abab\n");
  });
});

describe("x64 windows executable entry requirements", () => {
  it("names the output after the module", () => {
    expect(build(src("fn main() -> int:", "  return 1")).files.map((file) => file.name)).toEqual(
      ["program.exe"],
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
});

const CLASS_PROGRAM = src(
  "class Point:",
  "  public constructor(x: int, y: int):",
  "    this.x = x",
  "    this.y = y",
  "  public sum() -> int:",
  "    return this.x + this.y",
  "",
  "fn main() -> int:",
  "  p = Point(20, 22)",
  "  return p.sum()",
);

describe("x64 windows executables with classes", () => {
  itRunsPe("allocates an instance and reads a field back through a method", () => {
    expect(runPe(imageOf(CLASS_PROGRAM, "main", "print")).stdout.trim()).toBe("42");
  });

  itRunsPe("runs accessors, statics, super and for-of in one native program", () => {
    const image = imageOf(
      src(
        "class Shape:",
        "  public constructor(n: int):",
        "    this.n = n",
        "  public area() -> int:",
        "    return this.n",
        "  public get label() -> int:",
        "    return this.n * 100",
        "  public set label(value: int):",
        "    this.n = Math.floor(value / 100)",
        "class Square extends Shape:",
        "  public constructor(n: int):",
        "    super(n=n)",
        "  public area() -> int:",
        "    return super.area() * this.n",
        "  public static of(n: int) -> Square:",
        "    return Square(n)",
        "",
        "fn main() -> int:",
        "  total = 0",
        "  for s of [Shape(3), Square.of(4)]:",
        "    total = total + s.area() + s.label",
        "  edge = Square.of(1)",
        "  edge.label = 500",
        "  return total + edge.area()",
      ),
      "main",
      "print",
    );

    const run = runPe(image);
    expect([run.status, run.stdout.trim()]).toEqual([0, String(3 + 300 + 16 + 400 + 25)]);
  });

  itRunsPe("runs a static field initializer before the program body", () => {
    const image = imageOf(
      src(
        "class Config:",
        "  public static limit: int = 42",
        "  public constructor(v: int):",
        "    this.v = v",
        "",
        "print(Config.limit)",
      ),
      null,
    );

    expect(runPe(image).stdout.trimEnd()).toBe("42");
  });

  it("keeps the arena out of the file so the image does not grow with it", () => {
    const withClass = imageOf(CLASS_PROGRAM, "main", "print").length;
    const withoutClass = imageOf(
      src("fn main() -> int:", "  return 42"),
      "main",
      "print",
    ).length;

    expect(withClass - withoutClass).toBeLessThan(TERA_HEAP_COMMIT_BYTES);
  });

  it("keeps the statics block out of the file as well", () => {
    const withStatics = imageOf(
      src(
        "class Config:",
        "  public static limit: int = 42",
        "  public constructor(v: int):",
        "    this.v = v",
        "",
        "fn main() -> int:",
        "  return Config.limit",
      ),
      "main",
      "print",
    ).length;
    const withoutStatics = imageOf(CLASS_PROGRAM, "main", "print").length;

    expect(withStatics - withoutStatics).toBeLessThan(TERA_STATICS.size);
  });
});

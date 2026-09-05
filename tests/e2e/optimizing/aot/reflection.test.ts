import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource } from "../../../helpers/c-executor.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { codeUnitArrayLiteral } from "../../../../src/optimizing/target/text-literal.js";

const src = (...lines: string[]) => lines.join("\n");

const SHAPES = src(
  "class Shape:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public area() -> int:",
  "    return this.n",
  "class Circle extends Shape:",
  "  public constructor(r: int):",
  "    super(r)",
  "  public radius() -> int:",
  "    return this.n",
  "class Square extends Shape:",
  "  public constructor(s: int):",
  "    super(s)",
);

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function compiled(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program;
}

function agrees(source: string): void {
  const run = runPe(compiled(source).files[0]!.contents as Uint8Array);

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function emitted(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  expect(program.skipped).toEqual([]);
  return cSource(program);
}

describe("AOT typeof", () => {
  itRunsPe("names the type of every scalar the way the interpreter does", () => {
    agrees(
      src(
        "fn kinds(n: int, x: float, s: string, b: bool) -> string:",
        '  return typeof n + " " + typeof x + " " + typeof s + " " + typeof b',
        'print(kinds(1, 1.5, "a", true))',
      ),
    );
  });

  itRunsPe("names the type of a class instance", () => {
    agrees(src(SHAPES, "fn kind(s: Shape) -> string:", "  return typeof s", "print(kind(Circle(1)))"));
  });

  itRunsPe("names the type of an array", () => {
    agrees(src("fn kind(xs: int[]) -> string:", "  return typeof xs", "print(kind([1, 2]))"));
  });

  it("answers typeof without leaving a call in the emitted code", () => {
    const source = src("fn kind(n: int) -> string:", "  return typeof n", "print(kind(1))");

    expect(emitted(source)).toContain(codeUnitArrayLiteral("number"));
  });
});

describe("AOT instanceof", () => {
  itRunsPe("recognises the class a value was built from", () => {
    agrees(
      src(SHAPES, "fn round(c: Circle) -> bool:", "  return c instanceof Circle", "print(round(Circle(1)))"),
    );
  });

  itRunsPe("recognises a parent class", () => {
    agrees(
      src(SHAPES, "fn shaped(c: Circle) -> bool:", "  return c instanceof Shape", "print(shaped(Circle(1)))"),
    );
  });

  itRunsPe("tells subclasses apart behind a shared parent type", () => {
    agrees(
      src(
        SHAPES,
        "fn round(s: Shape) -> bool:",
        "  return s instanceof Circle",
        "print(round(Circle(1)))",
        "print(round(Square(2)))",
        "print(round(Shape(3)))",
      ),
    );
  });

  itRunsPe("agrees with the interpreter on a sibling class", () => {
    agrees(
      src(
        SHAPES,
        "fn square(s: Shape) -> bool:",
        "  return s instanceof Square",
        "print(square(Circle(1)))",
        "print(square(Square(2)))",
      ),
    );
  });

  it("answers a settled instanceof without reading the value", () => {
    const source = src(
      SHAPES,
      "fn shaped(c: Circle) -> bool:",
      "  return c instanceof Shape",
      "print(shaped(Circle(1)))",
    );

    expect(emitted(source)).toMatch(/shaped\([^)]*\)\s*\{\s*const int32_t v0 = 1;/);
  });
});

describe("AOT new expressions", () => {
  itRunsPe("builds the same instance as a plain constructor call", () => {
    agrees(
      src(
        SHAPES,
        "a = new Circle(2)",
        "b = Circle(2)",
        "print(a.area(), b.area())",
      ),
    );
  });

  itRunsPe("builds a subclass through new", () => {
    agrees(src(SHAPES, "s: Shape = new Square(5)", "print(s.area())"));
  });

  itRunsPe("returns a new instance from a function", () => {
    agrees(
      src(SHAPES, "fn make(n: int) -> Circle:", "  return new Circle(n)", "print(make(4).radius())"),
    );
  });
});

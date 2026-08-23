import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { cCalls } from "../../../helpers/aot-agreement.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string, backend = "c") {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend });
  expect(program.skipped).toEqual([]);
  return program;
}

const native = cCalls({
  toC: (source: string) => cSource(compile(source)),
  interpret: (source: string, call: string) => interpret(source, call),
});

function interpret(source: string, call: string): unknown {
  return nodeEngine({ typecheck: "off" }).runNative(`${source}\n${call}\n`);
}

function ran(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return runPe(program.files[0]!.contents as Uint8Array);
}

const BAG = src(
  "class Bag:",
  "  public size: int = 0",
  "  public constructor(...items: int):",
  "    this.size = items.length",
);

const COUNTER = src(
  "class Counter:",
  "  public constructor():",
  "    this.n = 0",
  "  public add(...values: int) -> int:",
  "    return values.length",
);

const CONE = src(
  "class Base:",
  "  public constructor():",
  "    this.tag = 1",
  "  public add(...values: int) -> int:",
  "    return values.length",
  "class Child extends Base:",
  "  public add(...values: int) -> int:",
  "    return values.length * 10",
  "fn dispatch(shape: Base) -> int:",
  "  return shape.add(1, 2)",
);

describe("AOT rest parameters", () => {
  itNative("counts the arguments a call gathered", native.matches(
      src("fn total(...rest: int) -> int:", "  return rest.length", "fn go(n: int) -> int:", "  return total(n, n, n)"),
      "go",
      [4],
    ));

  itNative("reads a gathered argument by index", native.matches(
      src(
        "fn second(...rest: int) -> int:",
        "  return rest[1]",
        "fn go(n: int) -> int:",
        "  return second(n, n + 5)",
      ),
      "go",
      [4],
    ));

  itNative("walks the gathered arguments with for-of", native.matches(
      src(
        "fn sum(...values: int) -> int:",
        "  total = 0",
        "  for value of values:",
        "    total = total + value",
        "  return total",
        "fn go(n: int) -> int:",
        "  return sum(n, n + 1, n + 2)",
      ),
      "go",
      [4],
    ));

  itNative("gathers only the arguments after the declared parameters", native.matches(
      src(
        "fn tail(first: int, ...rest: int) -> int:",
        "  return first * 100 + rest.length",
        "fn go(n: int) -> int:",
        "  return tail(n, n, n)",
      ),
      "go",
      [4],
    ));

  itNative("reads the length of an array the function built itself", native.matches(
      src("fn go(n: int) -> int:", "  xs = [n, n + 1, n + 2]", "  return xs.length"),
      "go",
      [4],
    ));

  itRunsPe("constructs a class whose constructor gathers its arguments", () => {
    expect(ran(src(BAG, "print(Bag(1, 2, 3).size)")).stdout).toBe("3\n");
  });

  itRunsPe("constructs a subclass that forwards to a gathering constructor", () => {
    const run = ran(
      src(
        BAG,
        "class Small extends Bag:",
        "  public doubled() -> int:",
        "    return this.size * 2",
        "print(Small(1, 2).doubled())",
      ),
    );

    expect(run.stdout).toBe("4\n");
  });

  itNative("gathers a different count for each arity a call site uses", native.matches(
      src(
        "fn total(...rest: int) -> int:",
        "  return rest.length",
        "fn go(n: int) -> int:",
        "  return total(n) + total(n, n) + total(n, n, n)",
      ),
      "go",
      [4],
    ));

  it("compiles one clone per arity and no clone nobody calls", () => {
    const program = compile(
      src(
        "fn total(...rest: int) -> int:",
        "  return rest.length",
        "fn go(n: int) -> int:",
        "  return total(n) + total(n, n)",
      ),
    );

    expect(program.compiled.map((fn) => fn.name).sort()).toEqual([
      "go",
      "tera_program",
      "total$1",
      "total$2",
    ]);
  });

  itRunsPe("calls a method that gathers its arguments", () => {
    expect(ran(src(COUNTER, "c = Counter()", "print(c.add(1, 2, 3))")).stdout).toBe("3\n");
  });

  itRunsPe("dispatches a gathering method to the override the receiver's class defines", () => {
    expect(ran(src(CONE, "print(dispatch(Base()) + dispatch(Child()))")).stdout).toBe("22\n");
  });

  it("declines a gathering method that its class cone disagrees about", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(CONE, "print(dispatch(Base()) + Child().add(1))"),
      { backend: "c" },
    );

    expect(program.skipped.map((fn) => fn.reason).join("; ")).toContain(
      "call to Child.add, which takes a variable number of arguments",
    );
  });

  itRunsPe("types an undeclared rest parameter from what its callers gather", () => {
    expect(
      ran(
        src(
          "fn total(...rest) -> int:",
          "  return rest.length",
          "fn go(n: int) -> int:",
          "  return total(n, n)",
          "print(go(4))",
        ),
      ).stdout,
    ).toBe("2\n");
  });

  it("refuses a rest parameter no call site can type", () => {
    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(
        src(
          "fn total(...rest) -> int:",
          "  return rest.length",
          "fn go(n: int) -> int:",
          '  return total(n) + total("a")',
        ) + "\n",
        { backend: "c" },
      ),
    ).toThrow("rest parameter 'rest' has no declared type");
  });

  itRunsPe("reads a field whose type comes from a rest parameter", () => {
    const run = ran(
      src(
        "class Tally:",
        "  public constructor(...items: int):",
        "    this.n = items.length",
        "print(Tally(1, 2, 3).n)",
      ),
    );

    expect(run.stdout).toBe("3\n");
  });
});

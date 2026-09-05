import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

const ADDER = [
  "fn adder(base: int) -> fn(int) -> int:",
  "  fn add(x: int) -> int:",
  "    return base + x",
  "  return add",
];

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

describe("AOT closures", () => {
  itRunsPe("calls a closure the maker returned", () => {
    agrees(src(...ADDER, "add10 = adder(10)", "print(add10(5))"));
  });

  itRunsPe("keeps two closures from one maker apart", () => {
    agrees(src(...ADDER, "add10 = adder(10)", "add3 = adder(3)", "print(add10(5), add3(5))"));
  });

  itRunsPe("calls one closure more than once", () => {
    agrees(src(...ADDER, "add10 = adder(10)", "print(add10(5))", "print(add10(6))"));
  });

  itRunsPe("captures a float the same way", () => {
    agrees(
      src(
        "fn scaler(k: float) -> fn(float) -> float:",
        "  fn scale(v: float) -> float:",
        "    return v * k",
        "  return scale",
        "half = scaler(0.5)",
        "print(half(9.0))",
      ),
    );
  });

  itRunsPe("calls a closure inside the function that made it", () => {
    agrees(
      src(
        "fn twice(base: int) -> int:",
        "  fn add(x: int) -> int:",
        "    return base + x",
        "  return add(1) + add(2)",
        "print(twice(10))",
      ),
    );
  });

  itRunsPe("calls a lambda a variable was declared to hold", () => {
    agrees(src("inc: (int) -> int = n => n + 1", "print(inc(4))"));
  });

  itRunsPe("reads the result of such a lambda into a declared variable", () => {
    agrees(src("inc: (int) -> int = n => n + 1", "r: int = inc(4)", "print(r)"));
  });

  itRunsPe("keeps the declared types of a lambda over floats", () => {
    agrees(src("half: (float) -> float = x => x / 2.0", "print(half(9.0))"));
  });

  itRunsPe("calls a lambda over text", () => {
    agrees(src("shout: (string) -> string = s => s + \"!\"", 'print(shout("hi"))'));
  });

  itRunsPe("calls a lambda the maker returned", () => {
    agrees(
      src("fn adder(base: int) -> (int) -> int:", "  return n => n + base", "print(adder(3)(4))"),
    );
  });

  itRunsPe("keeps two returned lambdas apart", () => {
    agrees(
      src(
        "fn adder(base: int) -> (int) -> int:",
        "  return n => n + base",
        "a = adder(10)",
        "b = adder(100)",
        "print(a(1), b(1))",
      ),
    );
  });

  itRunsPe("takes a lambda parameter type from the parameter it is passed to", () => {
    agrees(
      src(
        "fn apply(f: (int) -> int, n: int) -> int:",
        "  return f(n)",
        "print(apply(n => n * 3, 4))",
      ),
    );
  });
});

describe("handing a closure to a function that calls it", () => {
  const APPLY = [
    "fn apply_all(xs: int[], f: fn(int) -> int) -> int[]:",
    "  out: int[] = []",
    "  for x of xs:",
    "    out.push(f(x))",
    "  return out",
  ];

  itRunsPe("calls the closure through the parameter it arrived in", () => {
    agrees(src(...ADDER, ...APPLY, "add5 = adder(5)", "print(apply_all([1, 2, 3], add5))"));
  });

  itRunsPe("keeps two closures from one maker apart across the handoff", () => {
    agrees(
      src(
        ...ADDER,
        ...APPLY,
        "add1 = adder(1)",
        "add100 = adder(100)",
        "print(apply_all([1, 2], add1))",
        "print(apply_all([1, 2], add100))",
      ),
    );
  });

  itRunsPe("takes a plain function through the same parameter", () => {
    agrees(
      src(
        ...ADDER,
        ...APPLY,
        "fn double(x: int) -> int:",
        "  return x * 2",
        "add5 = adder(5)",
        "print(apply_all([1, 2], add5))",
        "print(apply_all([1, 2], double))",
      ),
    );
  });

  itRunsPe("composes two closures a caller handed over", () => {
    agrees(
      src(
        ...ADDER,
        "fn scaler(by: int) -> fn(int) -> int:",
        "  fn scale(x: int) -> int:",
        "    return by * x",
        "  return scale",
        "fn compose(f: fn(int) -> int, g: fn(int) -> int, v: int) -> int:",
        "  return g(f(v))",
        "print(compose(adder(5), scaler(3), 2))",
      ),
    );
  });
});

describe("a closure that captures more than one value", () => {
  itRunsPe("carries two numbers it captured", () => {
    agrees(
      src(
        "fn make(base: int, step: int) -> fn(int) -> int:",
        "  fn go(x: int) -> int:",
        "    return base + step * x",
        "  return go",
        "h = make(1, 2)",
        "print(h(7), h(0))",
      ),
    );
  });

  itRunsPe("keeps two makers with different captures apart", () => {
    agrees(
      src(
        "fn make(base: int, step: int) -> fn(int) -> int:",
        "  fn go(x: int) -> int:",
        "    return base + step * x",
        "  return go",
        "a = make(1, 2)",
        "b = make(100, 10)",
        "print(a(3), b(3), a(0), b(0))",
      ),
    );
  });

  itRunsPe("captures two functions and calls both", () => {
    agrees(
      src(
        "fn double(x: int) -> int:",
        "  return x * 2",
        "fn inc(x: int) -> int:",
        "  return x + 1",
        "fn compose(f: fn(int) -> int, g: fn(int) -> int) -> fn(int) -> int:",
        "  fn both(x: int) -> int:",
        "    return g(f(x))",
        "  return both",
        "h = compose(double, inc)",
        "print(h(7), h(0))",
      ),
    );
  });

  itRunsPe("mixes a two-capture closure with a one-capture one", () => {
    agrees(
      src(
        ...ADDER,
        "fn make(base: int, step: int) -> fn(int) -> int:",
        "  fn go(x: int) -> int:",
        "    return base + step * x",
        "  return go",
        "print(adder(5)(1), make(1, 2)(7))",
      ),
    );
  });
});

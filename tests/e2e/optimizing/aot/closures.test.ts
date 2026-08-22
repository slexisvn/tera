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

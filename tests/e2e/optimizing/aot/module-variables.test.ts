import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

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

describe("AOT module-level variables", () => {
  itRunsPe("reads a module constant from inside a function", () => {
    agrees(
      src(
        "RATE = 0.07",
        "fn tax(amount: float) -> float:",
        "  return amount * RATE",
        "print(tax(100.0))",
      ),
    );
  });

  itRunsPe("carries a module counter across calls", () => {
    agrees(
      src(
        "counter = 0",
        "fn bump() -> int:",
        "  counter += 1",
        "  return counter",
        "bump()",
        "bump()",
        "print(counter)",
      ),
    );
  });

  itRunsPe("reads a module array a function only measures", () => {
    agrees(
      src(
        "NAMES: string[] = [\"ann\", \"bob\"]",
        "fn count() -> int:",
        "  return NAMES.length",
        "print(count())",
      ),
    );
  });

  itRunsPe("keeps a module string a function reads", () => {
    agrees(
      src(
        "GREETING = \"hello\"",
        "fn greet(who: string) -> string:",
        "  return GREETING + \" \" + who",
        "print(greet(\"world\"))",
      ),
    );
  });

  itRunsPe("keeps a module object alive for the function that reads it", () => {
    agrees(
      src(
        "class Cell:",
        "  public constructor(v: int):",
        "    this.v = v",
        "shared = Cell(7)",
        "fn reading() -> int:",
        "  return shared.v",
        "print(reading())",
      ),
    );
  });

  itRunsPe("builds the value a module variable holds the first time it is asked for", () => {
    agrees(
      src(
        "class Registry:",
        "  public constructor():",
        "    this.names = []",
        "    this.rates = []",
        "  public register(name: string, rate: float) -> int:",
        "    this.names.push(name)",
        "    this.rates.push(rate)",
        "    return this.names.length",
        "  public rate_for(name: string) -> float:",
        "    at = 0",
        "    for held of this.names:",
        "      if held == name:",
        "        return this.rates[at]",
        "      at = at + 1",
        "    return 0.0",
        "registry = null",
        "fn shared() -> Registry:",
        "  if registry == null:",
        "    registry = Registry()",
        '    registry.register("standard", 1.0)',
        '    registry.register("express", 2.5)',
        "  return registry",
        'print(shared().rate_for("standard"))',
        'print(shared().rate_for("express"))',
        'print(shared().rate_for("unknown"))',
      ),
    );
  });

  itRunsPe("writes a module variable from a function and reads it from another", () => {
    agrees(
      src(
        "total = 0",
        "fn add(n: int):",
        "  total += n",
        "fn report() -> int:",
        "  return total",
        "add(3)",
        "add(4)",
        "print(report())",
      ),
    );
  });
});

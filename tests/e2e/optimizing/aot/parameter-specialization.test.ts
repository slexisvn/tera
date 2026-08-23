import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n") + "\n";

const DISAGREEING = src(
  "fn show(v):",
  "  print(v)",
  "show(1)",
  'show("a")',
);

const THREE_WAYS = src(
  "fn answered(v):",
  "  return v",
  "print(answered(1))",
  'print(answered("a"))',
  "print(answered(2.5))",
);

const PARTLY_DECLARED = src(
  "fn tagged(label: string, v):",
  "  print(label, v)",
  'tagged("n", 7)',
  'tagged("s", "x")',
);

const AGREEING = src(
  "fn scaled(v):",
  "  return v * 2",
  "print(scaled(3))",
  "print(scaled(4))",
);

const HANDED_OFF = src(
  "fn show(v):",
  "  print(v)",
  "fn run(f: (int) -> void, n: int):",
  "  f(n)",
  "show(1)",
  "run(show, 2)",
);

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(source);
  return stream.join("");
}

function compiled(source: string): AotProgram {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source);
  expect(program.skipped).toEqual([]);
  return program;
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(source, {
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

const namesIn = (program: AotProgram): readonly string[] =>
  program.compiled.map((fn) => fn.name);

describe("AOT specialization on argument types", () => {
  itNative("compiles one copy per type the call sites disagree on", () => {
    const names = namesIn(compiled(DISAGREEING));

    expect(names).toContain("show$int");
    expect(names).toContain("show$string");
    expect(names).not.toContain("show");
  });

  itRunsPe("answers what the interpreter answered for each type", () => {
    agrees(DISAGREEING);
  });

  itRunsPe("splits three ways when three types are passed", () => {
    agrees(THREE_WAYS);
  });

  itNative("keeps the parameters that were already declared", () => {
    const names = namesIn(compiled(PARTLY_DECLARED));

    expect(names).toContain("tagged$string$int");
    expect(names).toContain("tagged$string$string");
  });

  itRunsPe("answers what the interpreter answered when only some are declared", () => {
    agrees(PARTLY_DECLARED);
  });

  itNative("leaves call sites that agree as one function", () => {
    const names = namesIn(compiled(AGREEING));

    expect(names).toContain("scaled");
    expect(names.filter((name) => name.startsWith("scaled"))).toHaveLength(1);
  });

  itNative("leaves a function that is also handed to another function alone", () => {
    expect(cSource(compiled(HANDED_OFF))).not.toContain("show$int");
  });

  itRunsPe("answers what the interpreter answered when the function is handed off", () => {
    agrees(HANDED_OFF);
  });
});

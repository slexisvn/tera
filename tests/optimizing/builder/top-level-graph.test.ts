import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";
import { validateOptimizedGraph } from "../../../src/optimizing/validation/graph-validator.js";

const SOURCE = `fn work(n: int) -> int:
  total = 0
  i = 0
  while (i < n):
    total = (total + (i * 3))
    i = (i + 1)
  return total

print(work(400))
`;

const TOP_LEVEL = "<script>";

const FORCED_TIERING = {
  jitThreshold: 2,
  baselineThreshold: 1,
  loopOsrThreshold: 2,
  shouldOptimize: (fn: RegisterCompiledFunction) =>
    !fn.optimizedCode && !fn.disableOptimization,
};

interface Run {
  readonly printed: string[];
  readonly compiled: RegisterCompiledFunction[];
  readonly validation: string[];
}

function run(tieringPolicy: object | undefined): Run {
  const printed: string[] = [];
  const compiled: RegisterCompiledFunction[] = [];
  const validation: string[] = [];
  const engine = new Engine({
    tieringPolicy,
    onCompile: (fn) => void compiled.push(fn),
    onOptimize: (fn, graph) => {
      try {
        validateOptimizedGraph(graph);
      } catch (error) {
        validation.push(`${fn.name}: ${(error as Error).message}`);
      }
    },
    output: (text: string) => void printed.push(text),
  } as ConstructorParameters<typeof Engine>[0]);
  engine.run(SOURCE);
  return { printed, compiled, validation };
}

function named(run: Run, name: string): RegisterCompiledFunction {
  const fn = run.compiled.find((candidate) => candidate.name === name);
  expect(fn, `${name} was never compiled`).toBeDefined();
  return fn!;
}

describe("optimizing a module top level", () => {
  it("builds a graph the backend accepts", () => {
    const forced = run(FORCED_TIERING);
    const topLevel = named(forced, TOP_LEVEL);

    expect(forced.validation).toEqual([]);
    expect(topLevel.lastCompileFailureReason).toBeNull();
    expect(topLevel.disableOptimization).toBeFalsy();
    expect(topLevel.optimizedCode).toBeTruthy();
  });

  it("prints what the interpreter prints", () => {
    expect(run(FORCED_TIERING).printed).toEqual(run(undefined).printed);
  });

  it("optimizes named functions the same way it always did", () => {
    const work = named(run(FORCED_TIERING), "work");

    expect(work.lastCompileFailureReason).toBeNull();
    expect(work.optimizedCode).toBeTruthy();
  });
});

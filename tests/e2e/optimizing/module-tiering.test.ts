import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-tier-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

type Run = {
  output: string[];
  optimized: string[];
  inlined: string[];
};

function run(files: Record<string, string>): Run {
  const root = project(files);
  const output: string[] = [];
  const optimized: string[] = [];
  const inlined: string[] = [];
  const engine = nodeEngine({
    output: (text) => output.push(text),
    tieringPolicy: { jitThreshold: 4, baselineThreshold: 2, loopOsrThreshold: 4 },
    onOptimize: (fn: RegisterCompiledFunction, graph) => {
      optimized.push(fn.name ?? "<anonymous>");
      const dump = graph.dump();
      for (const line of dump.split("\n")) {
        if (line.includes("CallKnownFunction") || line.includes("CheckCallTarget")) {
          inlined.push(line.trim());
        }
      }
    },
  });
  engine.runModule(path.join(root, "main.tera"), { root });
  return { output, optimized, inlined };
}

const HOT_DRIVER = [
  "from mathlib import square",
  "fn work(n: int) -> int:",
  "  acc = 0",
  "  i = 0",
  "  while (i < n):",
  "    acc = (acc + square(i))",
  "    i = (i + 1)",
  "  return acc",
  "total = 0",
  "r = 0",
  "while (r < 20):",
  "  total = work(100)",
  "  r = (r + 1)",
  "print(total)",
  "",
].join("\n");

const MATHLIB = ["fn square(n: int) -> int:", "  return n * n", ""].join("\n");

describe("tiering across module boundaries", () => {
  it("produces the same result as the interpreter", () => {
    expect(run({ "main.tera": HOT_DRIVER, "mathlib.tera": MATHLIB }).output).toEqual(["328350"]);
  });

  it("optimizes a function whose callee lives in another module", () => {
    expect(run({ "main.tera": HOT_DRIVER, "mathlib.tera": MATHLIB }).optimized).toContain("work");
  });

  it("optimizes the imported function itself once it is hot", () => {
    expect(run({ "main.tera": HOT_DRIVER, "mathlib.tera": MATHLIB }).optimized).toContain("square");
  });

  it("keeps a hot loop correct when the imported value is a module-level constant", () => {
    expect(
      run({
        "main.tera": [
          "from config import factor",
          "fn work(n: int) -> int:",
          "  acc = 0",
          "  i = 0",
          "  while (i < n):",
          "    acc = (acc + (i * factor))",
          "    i = (i + 1)",
          "  return acc",
          "print(work(2000))",
          "",
        ].join("\n"),
        "config.tera": "factor = 3\n",
      }).output,
    ).toEqual(["5997000"]);
  });

  it("keeps a cross-module class correct in optimized code", () => {
    expect(
      run({
        "main.tera": [
          "from shapes import Box",
          "fn work(n: int) -> int:",
          "  acc = 0",
          "  i = 0",
          "  while (i < n):",
          "    b = Box(i)",
          "    acc = (acc + b.value())",
          "    i = (i + 1)",
          "  return acc",
          "print(work(2000))",
          "",
        ].join("\n"),
        "shapes.tera": [
          "class Box:",
          "  public constructor(v: int):",
          "    this.v = v",
          "  public value() -> int:",
          "    return this.v",
          "",
        ].join("\n"),
      }).output,
    ).toEqual(["1999000"]);
  });

  it("stays correct when the hot call target changes through a local", () => {
    expect(
      run({
        "main.tera": [
          "from swap import one, two",
          "fn work(n: int) -> int:",
          "  acc = 0",
          "  i = 0",
          "  pick = one",
          "  while (i < n):",
          "    if i == 1500:",
          "      pick = two",
          "    acc = (acc + pick(i))",
          "    i = (i + 1)",
          "  return acc",
          "print(work(2000))",
          "",
        ].join("\n"),
        "swap.tera": [
          "fn one(n: int) -> int:",
          "  return 1",
          "fn two(n: int) -> int:",
          "  return 2",
          "",
        ].join("\n"),
      }).output,
    ).toEqual(["2500"]);
  });

  it("keeps an imported binding constant because a callee cannot rebind it", () => {
    expect(
      run({
        "main.tera": [
          "from state import value, mutate",
          "mutate()",
          "print(value)",
          "",
        ].join("\n"),
        "state.tera": ["value = 1", "fn mutate():", "  value = 99", ""].join("\n"),
      }).output,
    ).toEqual(["1"]);
  });
});

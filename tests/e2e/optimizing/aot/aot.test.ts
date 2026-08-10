import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../../src/index.js";
import {
  CFGFunction,
  CFGInstruction,
  IR_GENERIC_ADD,
  IR_NEW_OBJECT,
  irConstant,
  irFloat64Add,
  irGenericAdd,
  irReturn,
  resetIRNodeIds,
} from "../../../../src/optimizing/ir/index.js";
import { detachNode } from "../../../../src/optimizing/ir/graph-edit.js";
import { cBackend } from "../../../../src/optimizing/backends/c/backend.js";
import { moduleFromGraphs } from "../../../../src/optimizing/compilation-unit.js";
import { compileModule, writeAotProgram } from "../../../../src/optimizing/drivers/aot.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";
import type { AotBackend } from "../../../../src/optimizing/target/backend.js";
import type { TransformPass } from "../../../../src/optimizing/infra/pass-manager.js";
import { itNative, runCFunction } from "../../../helpers/c-executor.js";

beforeEach(() => resetIRNodeIds());

const src = (...lines: string[]) => lines.join("\n");

function addTwo(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  const p0 = graph.addParameter(0);
  const p1 = graph.addParameter(1);
  const block = graph.addBlock();
  const sum = irFloat64Add(p0, p1);
  block.addNode(sum);
  block.addNode(irReturn(sum));
  return graph;
}

function genericAdd(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  const p0 = graph.addParameter(0);
  const p1 = graph.addParameter(1);
  const block = graph.addBlock();
  const sum = irGenericAdd(p0, p1);
  block.addNode(sum);
  block.addNode(irReturn(sum));
  return graph;
}

function returnsConstant(name: string, value: number): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  const constant = irConstant(value);
  block.addNode(constant);
  block.addNode(irReturn(constant));
  return graph;
}

function allocates(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  const object = new CFGInstruction(IR_NEW_OBJECT);
  block.addNode(object);
  block.addNode(irReturn(object));
  return graph;
}

function lowerGenericAddPass(): TransformPass<CFGFunction> {
  return {
    name: "lower-generic-add",
    preserves: { kind: "none" },
    run: (graph) => {
      let loweredCount = 0;
      for (const block of graph.blocks) {
        const nodes: CFGInstruction[] = [];
        for (const node of block.nodes) {
          if (node.type !== IR_GENERIC_ADD) {
            nodes.push(node);
            continue;
          }
          const lowered = irFloat64Add(node.inputs[0]!, node.inputs[1]!);
          lowered.block = block;
          for (const use of [...node.uses]) {
            for (let i = 0; i < use.inputs.length; i++) {
              if (use.inputs[i] === node) use.replaceInput(i, lowered);
            }
          }
          detachNode(node);
          nodes.push(lowered);
          loweredCount++;
        }
        block.nodes = nodes;
      }
      return { changed: loweredCount > 0 };
    },
  };
}

describe("Engine AOT", () => {
  itNative("compiles source functions into executable C output", () => {
    const engine = new Engine({ typecheck: "off" });
    const program = engine.compileAot(
      src(
        "fn answer():",
        "  return 40 + 2",
      ),
      { functionNames: ["answer"] },
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.symbol)).toEqual(["answer"]);
    expect(runCFunction(program.source, "answer", [])).toBe(42);
  });

  itNative("compiles a warmed numeric loop function into executable C output", () => {
    const engine = new Engine({
      typecheck: "off",
      tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
    });
    const source = src(
      "fn sum(n):",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + i",
      "    i = i + 1",
      "  return total",
      "sum(10)",
    );
    expect(engine.runNative(source)).toBe(45);
    const sum = engine.collectFunctions().find((fn) => fn.name === "sum");
    expect(sum).toBeDefined();

    const program = engine.compileAotFunctions([sum!]);

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.symbol)).toEqual(["sum"]);
    expect(runCFunction(program.source, "sum", [10])).toBe(45);
  });

  itNative("de-speculates overflowing int32 arithmetic into sound float64", () => {
    const engine = new Engine({
      typecheck: "off",
      tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
    });
    const source = src(
      "fn add(a, b):",
      "  return a + b",
      "add(1, 2)",
    );
    engine.runNative(source);
    const add = engine.collectFunctions().find((fn) => fn.name === "add");
    expect(add).toBeDefined();

    const program = engine.compileAotFunctions([add!]);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(program.source, "add", [1073741824, 1073741824])).toBe(2147483648);
  });

  itNative("renames functions that collide with C reserved identifiers", () => {
    const program = new Engine({ typecheck: "off" }).compileAot(
      src(
        "fn main() -> int:",
        "  return 7",
        "",
        "fn tag() -> int:",
        '  s = "main"',
        "  return s.length",
      ),
      { functionNames: ["main", "tag"] },
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.symbol)).toEqual(["tera_main", "tag"]);
    expect(runCFunction(program.source, "main", [])).toBe(7);
    expect(runCFunction(program.source, "tag", [])).toBe(4);
  });

  itNative("skips callers of functions the backend could not lower", () => {
    const program = new Engine({ typecheck: "off" }).compileAot(
      src(
        "fn helper(n):",
        "  o = {a: n}",
        "  return o.a",
        "",
        "fn caller(n):",
        "  return helper(n) + 1",
        "",
        "fn unrelated(n):",
        "  return n * 2",
      ),
      { functionNames: ["helper", "caller", "unrelated"] },
    );

    expect(program.compiled.map((fn) => fn.name)).toEqual(["unrelated"]);
    expect(program.skipped.map((fn) => fn.name).sort()).toEqual(["caller", "helper"]);
    expect(program.skipped.find((fn) => fn.name === "caller")!.reason).toContain(
      "calls unavailable function helper",
    );
    expect(runCFunction(program.source, "unrelated", [21])).toBe(42);
  });
});

const moduleOf = (graphs: CFGFunction[]) => moduleFromGraphs(graphs, "test-module");

describe("compileModule", () => {
  itNative("emits a program whose compiled functions execute with the backend semantics", () => {
    const program = compileModule(moduleOf([addTwo("sum"), returnsConstant("answer", 42)]), cBackend);

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.symbol)).toEqual(["sum", "answer"]);
    expect(runCFunction(program.source, "sum", [2.5, 7.5])).toBe(10);
    expect(runCFunction(program.source, "answer", [])).toBe(42);
  });

  itNative("runs the backend lowering pipeline before emission", () => {
    let receivedOptLevel = "";
    const backend: AotBackend = {
      ...cBackend,
      loweringPipeline: (options) => {
        receivedOptLevel = options.optLevel;
        return [lowerGenericAddPass()];
      },
    };
    const program = compileModule(moduleOf([genericAdd("lowered")]), backend, {
      compilerOptions: compilerOptions("max"),
    });

    expect(receivedOptLevel).toBe("max");
    expect(program.skipped).toEqual([]);
    expect(runCFunction(program.source, "lowered", [6, 4])).toBe(10);
  });

  it("records functions the backend cannot lower as skipped", () => {
    const program = compileModule(moduleOf([addTwo("sum"), allocates("makeObject")]), cBackend);

    expect(program.compiled.map((fn) => fn.name)).toEqual(["sum"]);
    expect(program.skipped).toHaveLength(1);
    expect(program.skipped[0]!.name).toBe("makeObject");
    expect(program.skipped[0]!.reason).toContain(IR_NEW_OBJECT);
  });

  it("skips a later function with a duplicate backend symbol", () => {
    const program = compileModule(
      moduleOf([returnsConstant("dup-name", 1), addTwo("dup name")]),
      cBackend,
    );

    expect(program.compiled.map((fn) => fn.symbol)).toEqual(["dup_name"]);
    expect(program.skipped).toHaveLength(1);
    expect(program.skipped[0]!.reason).toContain("duplicate symbol dup_name");
  });
});

describe("writeAotProgram", () => {
  itNative("writes executable AOT output to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tera-aot-"));
    try {
      const program = compileModule(moduleOf([addTwo("sum")]), cBackend);
      const { sourcePath } = writeAotProgram(program, dir);
      const source = readFileSync(sourcePath, "utf8");

      expect(runCFunction(source, "sum", [1, 2])).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

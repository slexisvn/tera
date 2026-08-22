import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { nodeEngine } from "../../../helpers/engine.js";
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
import {
  AotUndeclaredParameterError,
  compileModule,
} from "../../../../src/optimizing/drivers/aot.js";
import { writeAotProgram } from "../../../../src/optimizing/drivers/write.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";
import type { AotBackend } from "../../../../src/optimizing/target/backend.js";
import type { TransformPass } from "../../../../src/optimizing/infra/pass-manager.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";

beforeEach(() => resetIRNodeIds());

const src = (...lines: string[]) => lines.join("\n");

function takingTwo(name: string, params: readonly string[], returns: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = {
    params: [...params],
    names: params.map((_, at) => `p${at}`),
    returns,
  };
  return graph;
}

function addTwo(name: string): CFGFunction {
  const graph = takingTwo(name, ["float", "float"], "float");
  const p0 = graph.addParameter(0);
  const p1 = graph.addParameter(1);
  const block = graph.addBlock();
  const sum = irFloat64Add(p0, p1);
  block.addNode(sum);
  block.addNode(irReturn(sum));
  return graph;
}

function genericAdd(name: string): CFGFunction {
  const graph = takingTwo(name, ["float", "float"], "float");
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
    const engine = nodeEngine({ typecheck: "off" });
    const program = engine.compileAot(
      src(
        "fn answer():",
        "  return 40 + 2",
      ),
      { functionNames: ["answer"] },
    );

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.emitted.symbol)).toEqual(["answer"]);
    expect(runCFunction(cSource(program), "answer", [])).toBe(42);
  });

  it("gives same-named methods of different classes distinct symbols", () => {
    const engine = nodeEngine({ typecheck: "off" });
    const program = engine.compileAot(
      src(
        "class Shape:",
        "  public area() -> int:",
        "    return 0",
        "class Box:",
        "  public area() -> int:",
        "    return 1",
      ),
    );

    const named = [...program.compiled, ...program.skipped].map((fn) => fn.name);
    expect(named).toContain("Shape.area");
    expect(named).toContain("Box.area");
    expect(program.skipped.filter((fn) => fn.reason.includes("duplicate symbol"))).toEqual([]);
  });

  it("compiles the top level of a program that declares a class it never uses", () => {
    const engine = nodeEngine({ typecheck: "off" });
    const program = engine.compileAot(
      src(
        "class Point:",
        "  public constructor(x: int, y: int):",
        "    this.x = x",
        "    this.y = y",
        "print(1)",
      ),
    );

    expect(program.compiled.map((fn) => fn.name)).toContain("tera_program");
  });

  it("gives a class-typed parameter a reference representation, not a double", () => {
    const engine = nodeEngine({ typecheck: "off" });
    const program = engine.compileAot(
      src(
        "class Point:",
        "  public constructor(x: int):",
        "    this.x = x",
        "fn ignore(p: Point) -> int:",
        "  return 7",
      ),
    );

    expect(program.skipped.map((fn) => fn.name)).not.toContain("ignore");
    expect(cSource(program)).toContain("int32_t ignore(unsigned char *p0)");
  });

  it("keeps a constructor under the bare class name so calls still resolve", () => {
    const engine = nodeEngine({ typecheck: "off" });
    const program = engine.compileAot(
      src(
        "class Point:",
        "  public constructor(x: int):",
        "    this.x = x",
      ),
    );

    const named = [...program.compiled, ...program.skipped].map((fn) => fn.name);
    expect(named).toContain("Point");
  });

  it("separates a static member from an instance member of the same name", () => {
    const engine = nodeEngine({ typecheck: "off" });
    const program = engine.compileAot(
      src(
        "class Counter:",
        "  public static total() -> int:",
        "    return 0",
        "  public value() -> int:",
        "    return 1",
      ),
    );

    const named = [...program.compiled, ...program.skipped].map((fn) => fn.name);
    expect(named).toContain("Counter.static.total");
    expect(named).toContain("Counter.value");
  });

  itNative("compiles a warmed numeric loop function into executable C output", () => {
    const engine = nodeEngine({
      typecheck: "off",
      tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
    });
    const source = src(
      "fn sum(n: int) -> int:",
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
    expect(program.compiled.map((fn) => fn.emitted.symbol)).toEqual(["sum"]);
    expect(runCFunction(cSource(program), "sum", [10])).toBe(45);
  });

  itNative("keeps overflowing arithmetic on declared floats out of int32", () => {
    const engine = nodeEngine({
      typecheck: "off",
      tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 },
    });
    const source = src(
      "fn add(a: float, b: float) -> float:",
      "  return a + b",
      "add(1, 2)",
    );
    engine.runNative(source);
    const add = engine.collectFunctions().find((fn) => fn.name === "add");
    expect(add).toBeDefined();

    const program = engine.compileAotFunctions([add!]);

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "add", [1073741824, 1073741824])).toBe(2147483648);
  });

  itNative("renames functions that collide with C reserved identifiers", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
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
    expect(program.compiled.map((fn) => fn.emitted.symbol)).toEqual(["tera_main", "tag"]);
    expect(runCFunction(cSource(program), "main", [])).toBe(7);
    expect(runCFunction(cSource(program), "tag", [])).toBe(4);
  });

  itNative("keeps its own locals clear of the functions it calls", () => {
    // The emitter numbers locals b0, b1, v0…; a function of the same name would be
    // shadowed by one, and the call to it would stop being a call at all.
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "fn b1(n: int) -> int:",
        "  return n + 1",
        "",
        "fn f(n: int) -> int:",
        "  a: int = 0",
        "  i: int = 0",
        "  while i < n:",
        "    a = a + b1(i)",
        "    i = i + 1",
        "  return a",
      ),
      { functionNames: ["b1", "f"] },
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "f", [4])).toBe(10);
  });

  itNative("skips callers of functions the backend could not lower", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "fn helper(n: int) -> int:",
        "  return n.to_fixed(2).length",
        "",
        "fn caller(n: int) -> int:",
        "  return helper(n) + 1",
        "",
        "fn unrelated(n: int) -> int:",
        "  return n * 2",
      ),
      { functionNames: ["helper", "caller", "unrelated"] },
    );

    expect(program.compiled.map((fn) => fn.name)).toEqual(["unrelated"]);
    expect(program.skipped.map((fn) => fn.name).sort()).toEqual(["caller", "helper"]);
    expect(program.skipped.find((fn) => fn.name === "caller")!.reason).toContain(
      "calls unavailable function helper",
    );
    expect(runCFunction(cSource(program), "unrelated", [21])).toBe(42);
  });
});

const moduleOf = (graphs: CFGFunction[]) => moduleFromGraphs(graphs, "test-module");

describe("compileModule", () => {
  itNative("emits a program whose compiled functions execute with the backend semantics", () => {
    const program = compileModule(moduleOf([addTwo("sum"), returnsConstant("answer", 42)]), cBackend);

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.emitted.symbol)).toEqual(["sum", "answer"]);
    expect(runCFunction(cSource(program), "sum", [2.5, 7.5])).toBe(10);
    expect(runCFunction(cSource(program), "answer", [])).toBe(42);
  });

  it("refuses the whole program when a parameter has no declared type, naming each one", () => {
    const loose = takingTwo("loose", ["any", "int"], "int");
    const p0 = loose.addParameter(0);
    loose.addParameter(1);
    loose.addBlock().addNode(irReturn(p0));
    const alsoLoose = takingTwo("also_loose", ["int", "any"], "int");
    alsoLoose.addParameter(0);
    const q1 = alsoLoose.addParameter(1);
    alsoLoose.addBlock().addNode(irReturn(q1));

    let thrown: unknown;
    try {
      compileModule(moduleOf([addTwo("sum"), loose, alsoLoose]), cBackend);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AotUndeclaredParameterError);
    expect((thrown as AotUndeclaredParameterError).undeclared).toEqual([
      {
        name: "loose",
        reason:
          "parameter 'p0' has no declared type; declare it (for example 'p0: int'), " +
          "or keep this part interpreted",
      },
      {
        name: "also_loose",
        reason:
          "parameter 'p1' has no declared type; declare it (for example 'p1: int'), " +
          "or keep this part interpreted",
      },
    ]);
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
    expect(runCFunction(cSource(program), "lowered", [6, 4])).toBe(10);
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

    expect(program.compiled.map((fn) => fn.emitted.symbol)).toEqual(["dup_name"]);
    expect(program.skipped).toHaveLength(1);
    expect(program.skipped[0]!.reason).toContain("duplicate symbol dup_name");
  });
});

describe("writeAotProgram", () => {
  itNative("writes executable AOT output to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tera-aot-"));
    try {
      const program = compileModule(moduleOf([addTwo("sum")]), cBackend);
      const written = writeAotProgram(program, dir);
      const sourcePath = written.find((path) => path.endsWith(".c"))!;

      expect(written.map((path) => basename(path))).toEqual(["program.h", "program.c"]);
      expect(runCFunction(readFileSync(sourcePath, "utf8"), "sum", [1, 2])).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

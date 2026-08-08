import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../../src/optimizing/ir/index.js";
import { detachNode } from "../../src/optimizing/passes/graph-edit.js";
import { cBackend } from "../../src/optimizing/backends/c/backend.js";
import { compileProgram, writeAotProgram } from "../../src/optimizing/drivers/aot.js";
import { compilerOptions } from "../../src/optimizing/options.js";
import type { AotBackend } from "../../src/optimizing/target/backend.js";
import type { TransformPass } from "../../src/optimizing/infra/pass-manager.js";
import { runCFunction } from "./backends/c/c-executor.js";

beforeEach(() => resetIRNodeIds());

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

describe("compileProgram", () => {
  it("emits a program whose compiled functions execute with the backend semantics", () => {
    const program = compileProgram([addTwo("sum"), returnsConstant("answer", 42)], cBackend);

    expect(program.skipped).toEqual([]);
    expect(program.compiled.map((fn) => fn.symbol)).toEqual(["sum", "answer"]);
    expect(runCFunction(program.source, "sum", [2.5, 7.5])).toBe(10);
    expect(runCFunction(program.source, "answer", [])).toBe(42);
  });

  it("runs the backend lowering pipeline before emission", () => {
    let receivedOptLevel = "";
    const backend: AotBackend = {
      ...cBackend,
      loweringPipeline: (options) => {
        receivedOptLevel = options.optLevel;
        return [lowerGenericAddPass()];
      },
    };
    const program = compileProgram([genericAdd("lowered")], backend, {
      compilerOptions: compilerOptions("max"),
    });

    expect(receivedOptLevel).toBe("max");
    expect(program.skipped).toEqual([]);
    expect(runCFunction(program.source, "lowered", [6, 4])).toBe(10);
  });

  it("records functions the backend cannot lower as skipped", () => {
    const program = compileProgram([addTwo("sum"), allocates("makeObject")], cBackend);

    expect(program.compiled.map((fn) => fn.name)).toEqual(["sum"]);
    expect(program.skipped).toHaveLength(1);
    expect(program.skipped[0]!.name).toBe("makeObject");
    expect(program.skipped[0]!.reason).toContain(IR_NEW_OBJECT);
  });

  it("skips a later function with a duplicate backend symbol", () => {
    const program = compileProgram(
      [returnsConstant("dup-name", 1), addTwo("dup name")],
      cBackend,
    );

    expect(program.compiled.map((fn) => fn.symbol)).toEqual(["dup_name"]);
    expect(program.skipped).toHaveLength(1);
    expect(program.skipped[0]!.reason).toContain("duplicate symbol dup_name");
  });
});

describe("writeAotProgram", () => {
  it("writes executable AOT output to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tera-aot-"));
    try {
      const program = compileProgram([addTwo("sum")], cBackend);
      const { sourcePath } = writeAotProgram(program, dir);
      const source = readFileSync(sourcePath, "utf8");

      expect(runCFunction(source, "sum", [1, 2])).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

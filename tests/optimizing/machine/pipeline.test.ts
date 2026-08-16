import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irFloat64Add,
  irFloat64Compare,
  irInt32Add,
  irInt32Compare,
  irInt32Sub,
  irJump,
  irLoadElement,
  irReturn,
  irStoreElement,
  resetIRNodeIds,
  type CFGBlock,
} from "../../../src/optimizing/ir/index.js";
import { ARRAY_ELEMENTS_OFFSET } from "../../../src/optimizing/metadata/class-table.js";
import { SCALAR_FLOAT64 } from "../../../src/optimizing/types/scalar.js";
import { addPhi, connect, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import { createAnalysisRegistry } from "../../../src/optimizing/analyses/index.js";
import {
  aotLegalityAnalysisId,
  type AotLegality,
} from "../../../src/optimizing/analyses/aot-legality.js";
import { compileMachineFunction } from "../../../src/optimizing/machine/pipeline.js";
import { isVirtual, registerOperandsOf } from "../../../src/optimizing/machine/ir.js";
import type { MachineLowering } from "../../../src/optimizing/machine/lowering.js";
import { X64Lowering } from "../../../src/optimizing/backends/x64/lowering.js";
import { x64Target } from "../../../src/optimizing/backends/x64/target.js";
import { RiscvLowering } from "../../../src/optimizing/backends/riscv64/lowering.js";
import { riscvTarget } from "../../../src/optimizing/backends/riscv64/target.js";
import { expectDisjointAllocation } from "./support.js";

beforeEach(() => resetIRNodeIds());

const targets: Array<readonly [string, () => MachineLowering]> = [
  ["x64 sysv", () => new X64Lowering(x64Target({ abi: "sysv", format: "elf" }))],
  ["x64 win64", () => new X64Lowering(x64Target({ abi: "win64", format: "coff" }))],
  ["riscv64", () => new RiscvLowering(riscvTarget())],
];

function legalityOf(graph: CFGFunction): {
  legality: AotLegality;
  analyses: AnalysisManager<CFGFunction>;
} {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  const result = analyses.get(aotLegalityAnalysisId);
  if (!result.ok) throw new Error(`graph is not lowerable: ${result.reason}`);
  return { legality: result.legality, analyses };
}

function compile(graph: CFGFunction, lowering: MachineLowering) {
  const { legality, analyses } = legalityOf(graph);
  return compileMachineFunction(graph, legality, lowering, analyses, graph.name);
}

function countingLoop(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["int"], returns: "int" };
  const limit = graph.addParameter(0);
  const entry = graph.addBlock();
  const header = graph.addBlock();
  const body = graph.addBlock();
  const exit = graph.addBlock();

  const zero = irConstant(0);
  const one = irConstant(1);
  entry.addNode(zero);
  entry.addNode(one);
  entry.addNode(irJump(header));
  link(entry, header);

  const index = addPhi(header, [zero]);
  const total = addPhi(header, [zero]);
  const test = irInt32Compare("<", index, limit);
  header.addNode(test);
  header.addNode(irBranch(test, body, exit));
  link(header, body);
  link(header, exit);

  const next = irInt32Add(index, one);
  const sum = irInt32Add(total, index);
  body.addNode(next);
  body.addNode(sum);
  body.addNode(irJump(header));
  connect(body, header, [next, sum]);

  exit.addNode(irReturn(total));
  return graph;
}

function arraySum(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["float[]", "int"], returns: "float" };
  const array = graph.addParameter(0);
  const index = graph.addParameter(1);
  const block = graph.addBlock();
  const b = irConstant(2.5);
  const stored = irStoreElement(array, index, b);
  const loaded = irLoadElement(array, index);
  for (const node of [stored, loaded]) {
    node.props.elementScalar = SCALAR_FLOAT64;
    node.props.offset = ARRAY_ELEMENTS_OFFSET;
  }
  const sum = irFloat64Add(loaded, b);
  for (const node of [b, stored, loaded, sum]) block.addNode(node);
  block.addNode(irReturn(sum));
  return graph;
}

function floatBranch(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["float", "float"], returns: "float" };
  const left = graph.addParameter(0);
  const right = graph.addParameter(1);
  const entry = graph.addBlock();
  const onTrue = graph.addBlock();
  const onFalse = graph.addBlock();
  const test = irFloat64Compare("==", left, right);
  entry.addNode(test);
  entry.addNode(irBranch(test, onTrue, onFalse));
  link(entry, onTrue);
  link(entry, onFalse);
  onTrue.addNode(irReturn(left));
  onFalse.addNode(irReturn(right));
  return graph;
}

function subtraction(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  graph.declaredSignature = { params: ["int", "int"], returns: "int" };
  const left = graph.addParameter(0);
  const right = graph.addParameter(1);
  const block = graph.addBlock();
  const difference = irInt32Sub(left, right);
  block.addNode(difference);
  block.addNode(irReturn(difference));
  return graph;
}

const shapes: Array<readonly [string, (name: string) => CFGFunction]> = [
  ["counting loop", countingLoop],
  ["array access", arraySum],
  ["float branch", floatBranch],
  ["subtraction", subtraction],
];

describe.each(targets)("machine pipeline on %s", (_name, build) => {
  const lowering = build();

  it.each(shapes)("allocates every register for a %s", (shape, make) => {
    const compiled = compile(make(shape.replace(/\s/g, "_")), lowering);

    for (const block of compiled.fn.blocks) {
      for (const node of block.instructions) {
        for (const operand of registerOperandsOf(node)) {
          expect({ opcode: node.opcode, virtual: isVirtual(operand.register) }).toMatchObject({
            virtual: false,
          });
        }
      }
    }
  });

  it.each(shapes)("keeps live ranges of a %s in disjoint registers", (shape, make) => {
    const compiled = compile(make(shape.replace(/\s/g, "_")), lowering);
    expectDisjointAllocation(compiled.liveness, compiled.allocation);
  });

  it("aligns the frame so the stack pointer is aligned at a call", () => {
    const compiled = compile(countingLoop("frames"), lowering);
    const abi = lowering.target.abi;
    const total = compiled.frame.frameSize + abi.entryStackAdjustBytes;
    expect(total % abi.stackAlignmentBytes).toBe(0);
  });

  it("places every local slot inside the frame it reserved", () => {
    const compiled = compile(arraySum("slots"), lowering);
    for (const slot of compiled.fn.slots) {
      if (slot.kind !== "local") continue;
      expect(slot.offset).toBeGreaterThanOrEqual(compiled.frame.outgoingBytes);
      expect(slot.offset + slot.size).toBeLessThanOrEqual(compiled.frame.frameSize);
    }
  });

  it("moves incoming parameters out of the argument registers before use", () => {
    const compiled = compile(subtraction("params"), lowering);
    const argument = lowering.target.abi.callingConvention.argumentRegisters
      .get(lowering.target.integerClass.id)![0]!;
    const reader = compiled.fn.blocks[0]!.instructions.find((node) =>
      registerOperandsOf(node).some(
        (operand) => operand.role === "use" && operand.register === argument,
      ),
    );

    expect(reader?.flags.copy).toBe(true);
  });
});

describe("target independence", () => {
  it("selects the same block structure for every target", () => {
    const shapes = targets.map(([, build]) =>
      compile(countingLoop("shape"), build()).fn.blocks.length,
    );

    expect(new Set(shapes).size).toBe(1);
  });

  it("needs no destructive copies on a three address target", () => {
    const riscv = compile(subtraction("sub_riscv"), new RiscvLowering(riscvTarget()));
    const x64 = compile(
      subtraction("sub_x64"),
      new X64Lowering(x64Target({ abi: "sysv", format: "elf" })),
    );
    const copies = (fn: { blocks: readonly { instructions: readonly { flags: { copy?: boolean } }[] }[] }) =>
      fn.blocks.reduce(
        (total, block) =>
          total + block.instructions.filter((node) => node.flags.copy === true).length,
        0,
      );

    expect(copies(riscv.fn)).toBeLessThan(copies(x64.fn));
  });
});

describe("unreachable blocks", () => {
  it("drops blocks the dominator tree cannot reach", () => {
    const graph = new CFGFunction("unreachable");
    graph.declaredSignature = { params: [], returns: "int" };
    const entry = graph.addBlock();
    const orphan: CFGBlock = graph.addBlock();
    const value = irConstant(7);
    entry.addNode(value);
    entry.addNode(irReturn(value));
    const other = irConstant(9);
    orphan.addNode(other);
    orphan.addNode(irReturn(other));

    const compiled = compile(graph, new X64Lowering(x64Target({ abi: "sysv", format: "elf" })));
    expect(compiled.fn.blocks).toHaveLength(1);
  });
});

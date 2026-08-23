import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irCallKnownFunction,
  irConstant,
  irInt32Add,
  irInt32Compare,
  irInt32Sub,
  irJump,
  irLoadField,
  irReturn,
  resetIRNodeIds,
  IR_SELECT,
  type CFGBlock,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { addPhi, link } from "../../../src/optimizing/ir/cfg-edit.js";
import { ifConversion } from "../../../src/optimizing/passes/if-conversion.js";
import { validateGraphInvariants } from "../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

const ALWAYS = () => true;
const NEVER = () => false;
const BUDGET = 4;

interface Diamond {
  readonly graph: CFGFunction;
  readonly entry: CFGBlock;
  readonly onTrue: CFGBlock;
  readonly onFalse: CFGBlock;
  readonly join: CFGBlock;
  readonly merged: CFGInstruction;
}

function proven(node: CFGInstruction): CFGInstruction {
  node.props.noOverflow = true;
  return node;
}

function diamond(): Diamond {
  const graph = new CFGFunction("clamped");
  graph.declaredSignature = { params: ["int"], names: ["n"], returns: "int" };
  const n = graph.addParameter(0);
  const entry = graph.addBlock();
  const onTrue = graph.addBlock();
  const onFalse = graph.addBlock();
  const join = graph.addBlock();

  const zero = entry.addNode(irConstant(0));
  const negative = entry.addNode(irInt32Compare("<", n, zero));
  entry.addNode(irBranch(negative, onTrue, onFalse));
  link(entry, onTrue);
  link(entry, onFalse);

  const two = onTrue.addNode(irConstant(2));
  const raised = onTrue.addNode(proven(irInt32Add(n, two)));
  onTrue.addNode(irJump(join));
  const one = onFalse.addNode(irConstant(1));
  const lowered = onFalse.addNode(proven(irInt32Sub(n, one)));
  onFalse.addNode(irJump(join));

  link(onTrue, join);
  link(onFalse, join);
  const merged = addPhi(join, [raised, lowered]);
  join.addNode(irReturn(merged));
  graph.rebuildUses();
  return { graph, entry, onTrue, onFalse, join, merged };
}

function triangle(): Diamond {
  const graph = new CFGFunction("raised");
  graph.declaredSignature = { params: ["int"], names: ["n"], returns: "int" };
  const n = graph.addParameter(0);
  const entry = graph.addBlock();
  const onTrue = graph.addBlock();
  const join = graph.addBlock();

  const zero = entry.addNode(irConstant(0));
  const negative = entry.addNode(irInt32Compare("<", n, zero));
  entry.addNode(irBranch(negative, onTrue, join));
  link(entry, onTrue);

  const two = onTrue.addNode(irConstant(2));
  const raised = onTrue.addNode(proven(irInt32Add(n, two)));
  onTrue.addNode(irJump(join));
  link(entry, join);
  link(onTrue, join);

  const merged = addPhi(join, [n, raised]);
  join.addNode(irReturn(merged));
  graph.rebuildUses();
  return { graph, entry, onTrue, onFalse: join, join, merged };
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const selectsIn = (graph: CFGFunction): CFGInstruction[] =>
  nodesOf(graph).filter((node) => node.type === IR_SELECT);

describe("ifConversion", () => {
  it("replaces a diamond's phi with one select in the head", () => {
    const { graph, entry } = diamond();

    expect(ifConversion(graph, ALWAYS, BUDGET)).toBe(1);
    const selects = selectsIn(graph);
    expect(selects).toHaveLength(1);
    expect(selects[0]!.block).toBe(entry);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("keeps the arms in the order the condition chooses them", () => {
    const { graph } = diamond();
    ifConversion(graph, ALWAYS, BUDGET);

    const [select] = selectsIn(graph);
    expect(select!.inputs[0]!.type).toBe("Int32Compare");
    expect(select!.inputs[1]!.type).toBe("Int32Add");
    expect(select!.inputs[2]!.type).toBe("Int32Sub");
  });

  it("leaves the function with one block and no branch", () => {
    const { graph } = diamond();
    ifConversion(graph, ALWAYS, BUDGET);

    expect(graph.blocks).toHaveLength(2);
    expect(nodesOf(graph).some((node) => node.type === "Branch")).toBe(false);
  });

  it("converts a triangle whose else arm is the join itself", () => {
    const { graph, entry } = triangle();

    expect(ifConversion(graph, ALWAYS, BUDGET)).toBe(1);
    const [select] = selectsIn(graph);
    expect(select!.block).toBe(entry);
    expect(select!.inputs[2]).toBe(graph.parameters[0]);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("refuses a merged value the target cannot select", () => {
    const { graph } = diamond();

    expect(ifConversion(graph, NEVER, BUDGET)).toBe(0);
  });

  it("refuses an arm that costs more than the budget", () => {
    const { graph } = diamond();

    expect(ifConversion(graph, ALWAYS, 1)).toBe(0);
  });

  it("refuses an arm that reads memory, which the untaken path never would", () => {
    const { graph, onTrue } = diamond();
    const guarded = onTrue.getTerminator()!;
    const load = irLoadField(graph.parameters[0]!, 0);
    onTrue.nodes.splice(onTrue.nodes.indexOf(guarded), 0, load);
    load.block = onTrue;
    graph.rebuildUses();

    expect(ifConversion(graph, ALWAYS, BUDGET)).toBe(0);
  });

  it("refuses an arm that calls, because the call may not be safe to run", () => {
    const { graph, onFalse } = diamond();
    const terminator = onFalse.getTerminator()!;
    const call = irCallKnownFunction({ name: "side" } as never, [graph.parameters[0]!]);
    onFalse.nodes.splice(onFalse.nodes.indexOf(terminator), 0, call);
    call.block = onFalse;
    graph.rebuildUses();

    expect(ifConversion(graph, ALWAYS, BUDGET)).toBe(0);
  });

  it("refuses an arm whose arithmetic can still overflow into a deopt", () => {
    const { graph, onTrue } = diamond();
    const raised = onTrue.nodes.find((node) => node.type === "Int32Add")!;
    delete raised.props.noOverflow;

    expect(ifConversion(graph, ALWAYS, BUDGET)).toBe(0);
  });

  it("drops the phi outright when both arms merge the same value", () => {
    const { graph, merged } = diamond();
    merged.inputs[1] = merged.inputs[0]!;
    graph.rebuildUses();

    expect(ifConversion(graph, ALWAYS, BUDGET)).toBe(1);
    expect(selectsIn(graph)).toHaveLength(0);
    expect(validateGraphInvariants(graph)).toBe(true);
  });

  it("does nothing when the budget is zero", () => {
    const { graph } = diamond();

    expect(ifConversion(graph, ALWAYS, 0)).toBe(0);
    expect(graph.blocks).toHaveLength(4);
  });
});

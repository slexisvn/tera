import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  IR_CONSTANT,
  IR_RETURN,
  irConstant,
  irJump,
  irReturn,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import {
  PROGRAM_ENTRY_NAME,
  PROGRAM_ENTRY_RETURN,
  PROGRAM_ENTRY_STATUS,
  markProgramEntry,
} from "../../../src/optimizing/target/program-entry.js";

beforeEach(() => resetIRNodeIds());

function nodesOf(graph: CFGFunction): CFGInstruction[] {
  return graph.blocks.flatMap((block) => [...block.nodes]);
}

function returnsOf(graph: CFGFunction): CFGInstruction[] {
  return nodesOf(graph).filter((node) => node.type === IR_RETURN);
}

function bareReturn(): CFGInstruction {
  return new CFGInstruction(IR_RETURN);
}

function bare(name = "module"): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  block.addNode(bareReturn());
  return graph;
}

function withValue(value: number): CFGFunction {
  const graph = new CFGFunction("module");
  const block = graph.addBlock();
  const constant = irConstant(value);
  block.addNode(constant);
  block.addNode(irReturn(constant));
  return graph;
}

function twoExits(): CFGFunction {
  const graph = new CFGFunction("module");
  const head = graph.addBlock();
  const other = graph.addBlock();
  head.addNode(irJump(other));
  link(head, other);
  head.addNode(bareReturn());
  other.addNode(bareReturn());
  return graph;
}

describe("marking a graph as the compiled program's entry", () => {
  it("renames the graph so the backend emits the entry symbol", () => {
    const graph = bare("whatever_it_was_called");
    markProgramEntry(graph);

    expect(graph.name).toBe(PROGRAM_ENTRY_NAME);
  });

  it("declares the entry as taking nothing and returning an int", () => {
    const graph = bare();
    markProgramEntry(graph);

    expect(graph.declaredSignature).toEqual({ params: [], returns: PROGRAM_ENTRY_RETURN });
  });

  it("replaces a signature the graph already carried", () => {
    const graph = bare();
    graph.declaredSignature = { params: ["int"], names: ["p0"], returns: "float" };
    markProgramEntry(graph);

    expect(graph.declaredSignature).toEqual({ params: [], returns: PROGRAM_ENTRY_RETURN });
  });

  it("gives a bare return the success status to hand back", () => {
    const graph = bare();
    markProgramEntry(graph);
    const [exit] = returnsOf(graph);

    expect(exit!.inputs).toHaveLength(1);
    expect(exit!.inputs[0]!.type).toBe(IR_CONSTANT);
    expect(exit!.inputs[0]!.props.value).toBe(PROGRAM_ENTRY_STATUS);
  });

  it("drops the value a return already carried in favour of the status", () => {
    const graph = withValue(41);
    markProgramEntry(graph);
    const [exit] = returnsOf(graph);

    expect(exit!.inputs).toHaveLength(1);
    expect(exit!.inputs[0]!.props.value).toBe(PROGRAM_ENTRY_STATUS);
  });

  it("puts the status ahead of the return it feeds", () => {
    const graph = bare();
    markProgramEntry(graph);
    const block = graph.blocks[0]!;
    const status = block.nodes.findIndex((node) => node.type === IR_CONSTANT);
    const exit = block.nodes.findIndex((node) => node.type === IR_RETURN);

    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(exit);
  });

  it("gives every exit its own status, not one shared node", () => {
    const graph = twoExits();
    markProgramEntry(graph);
    const exits = returnsOf(graph);
    const statuses = exits.map((exit) => exit.inputs[0]!);

    expect(exits).toHaveLength(2);
    expect(new Set(statuses).size).toBe(2);
    for (const status of statuses) expect(status.props.value).toBe(PROGRAM_ENTRY_STATUS);
  });

  it("leaves a graph with no return untouched apart from its name and signature", () => {
    const graph = new CFGFunction("module");
    graph.addBlock();
    markProgramEntry(graph);

    expect(returnsOf(graph)).toEqual([]);
    expect(graph.name).toBe(PROGRAM_ENTRY_NAME);
  });

  it("records the status as a use so a later pass does not drop it", () => {
    const graph = bare();
    markProgramEntry(graph);
    const status = returnsOf(graph)[0]!.inputs[0]!;

    expect(status.uses.length).toBeGreaterThan(0);
  });

  it("adds no throw-reporting blocks when the graph never recovers a throw", () => {
    const graph = bare();
    const before = graph.blocks.length;
    markProgramEntry(graph);

    expect(graph.blocks).toHaveLength(before);
  });

  it("splits the exit so an uncaught throw is reported before the program returns", () => {
    const graph = bare();
    graph.recoversThrows = true;
    const before = graph.blocks.length;
    markProgramEntry(graph);

    expect(graph.blocks.length).toBeGreaterThan(before);
    expect(returnsOf(graph)).toHaveLength(1);
  });

  it("still hands back the success status on the path where nothing was thrown", () => {
    const graph = bare();
    graph.recoversThrows = true;
    markProgramEntry(graph);
    const [exit] = returnsOf(graph);

    expect(exit!.inputs[0]!.props.value).toBe(PROGRAM_ENTRY_STATUS);
  });

  it("reports an uncaught throw once per exit the graph had", () => {
    const one = bare();
    one.recoversThrows = true;
    const oneBefore = one.blocks.length;
    markProgramEntry(one);
    const perExit = one.blocks.length - oneBefore;

    const two = twoExits();
    two.recoversThrows = true;
    const twoBefore = two.blocks.length;
    markProgramEntry(two);

    expect(perExit).toBeGreaterThan(0);
    expect(two.blocks.length - twoBefore).toBe(2 * perExit);
    expect(returnsOf(two)).toHaveLength(2);
  });
});

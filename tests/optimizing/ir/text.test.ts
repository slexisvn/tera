import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  IR_CONSTANT,
  IR_PHI,
  irBranch,
  irCheckSmi,
  irConstant,
  irInt32Add,
  irJump,
  irReturn,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import {
  GRAPH_FIELDS,
  IRTextError,
  OpaqueValue,
  parseIR,
  printIR,
} from "../../../src/optimizing/ir/text.js";
import { FrameState } from "../../../src/deopt/frame-state.js";

beforeEach(() => resetIRNodeIds());

const STRAIGHT_LINE = `fn add params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Constant [value=2]
    v2 = Int32Add v0, v1
    v3 = Return v2
}
`;

describe("printing the IR as text", () => {
  it("names every value and lists inputs in order", () => {
    const graph = new CFGFunction("add");
    const parameter = graph.addParameter(0);
    const block = graph.addBlock();
    const two = block.addNode(irConstant(2));
    const sum = block.addNode(irInt32Add(parameter, two));
    block.addNode(irReturn(sum));
    graph.rebuildUses();

    expect(printIR(graph)).toBe(STRAIGHT_LINE);
  });

  it("marks a node that carries a frame state", () => {
    const graph = new CFGFunction("guard");
    const parameter = graph.addParameter(0);
    const block = graph.addBlock();
    const check = irCheckSmi(parameter);
    check.frameState = new FrameState(null, 0);
    block.addNode(check);
    block.addNode(irReturn(check));
    graph.rebuildUses();

    expect(printIR(graph)).toContain("= CheckSmi v0 !fs");
  });

  it("marks a loop header and lists both edge directions", () => {
    const graph = new CFGFunction("loop");
    const entry = graph.addBlock();
    const header = graph.addBlock();
    link(entry, header);
    link(header, header);
    header.isLoopHeader = true;
    entry.addNode(irJump(header));
    header.addNode(irJump(header));

    const text = printIR(graph);
    expect(text).toContain("B1 loop-header succs=B1 preds=B0,B1:");
  });
});

describe("parsing the IR from text", () => {
  it("round-trips a printed function unchanged", () => {
    expect(printIR(parseIR(STRAIGHT_LINE))).toBe(STRAIGHT_LINE);
  });

  it("rebuilds the use list so a pass can walk consumers", () => {
    const graph = parseIR(STRAIGHT_LINE);
    const parameter = graph.parameters[0]!;
    expect(parameter.uses.map((use) => use.type)).toEqual(["Int32Add"]);
  });

  it("restores property values with their original types", () => {
    const graph = parseIR(`fn props params=0 {
  B0 succs= preds=:
    v0 = Constant [value="hi"]
    v1 = Constant [value=-0]
    v2 = Constant [value=[1, true, null]]
    v3 = Return v0
}
`);
    const values = graph.blocks[0]!.nodes.map((node) => node.props.value);
    expect(values[0]).toBe("hi");
    expect(Object.is(values[1], -0)).toBe(true);
    expect(values[2]).toEqual([1, true, null]);
  });

  it("wires phis into both the block node list and its phi list", () => {
    const graph = parseIR(`fn merge params=0 {
  B0 succs=B1 preds=:
    v0 = Constant [value=1]
    v1 = Jump [targetBlock=1]
  B1 succs= preds=B0:
    v2 = Phi v0
    v3 = Return v2
}
`);
    const merge = graph.blocks[1]!;
    expect(merge.phis).toHaveLength(1);
    expect(merge.phis[0]).toBe(merge.nodes[0]);
    expect(merge.nodes[0]!.type).toBe(IR_PHI);
  });

  it("derives predecessors from successors when they are left out", () => {
    const graph = parseIR(`fn derived params=0 {
  B0 succs=B1:
    v0 = Jump [targetBlock=1]
  B1 succs=:
    v1 = Constant [value=1]
    v2 = Return v1
}
`);
    expect(graph.blocks[1]!.predecessors).toEqual([graph.blocks[0]]);
  });

  it("keeps a value reference held in a property", () => {
    const graph = parseIR(`fn held params=0 {
  B0 succs= preds=:
    v0 = Constant [value=1]
    v1 = Constant [value=2, other=v0]
    v2 = Return v1
}
`);
    expect(graph.blocks[0]!.nodes[1]!.props.other).toBe(graph.blocks[0]!.nodes[0]);
  });

  it("refuses an opcode the IR does not define", () => {
    expect(() =>
      parseIR(`fn bad params=0 {
  B0 succs= preds=:
    v0 = Nonsense
}
`),
    ).toThrow(IRTextError);
  });

  it("refuses a value that was never defined", () => {
    expect(() =>
      parseIR(`fn bad params=0 {
  B0 succs= preds=:
    v0 = Return v9
}
`),
    ).toThrow(/unknown value v9/);
  });

  it("names the type of a property it cannot represent, and keeps the name", () => {
    const text = `fn opaque params=0 {
  B0 succs= preds=:
    v0 = CheckCallTarget [expectedTarget=<opaque:RegisterCompiledFunction>]
    v1 = Return v0
}
`;
    const graph = parseIR(text);
    expect(graph.blocks[0]!.nodes[0]!.props.expectedTarget).toBeInstanceOf(OpaqueValue);
    expect(printIR(graph)).toBe(text);
  });

  it("refuses a property value in no representable form", () => {
    expect(() =>
      parseIR(`fn bad params=0 {
  B0 succs= preds=:
    v0 = Constant [value=???]
}
`),
    ).toThrow(/cannot parse property value/);
  });

  it("refuses a header whose parameter count disagrees with the listing", () => {
    expect(() =>
      parseIR(`fn bad params=2 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Return v0
}
`),
    ).toThrow(/params=2/);
  });
});

describe("round-tripping a branching function", () => {
  const BRANCHING = `fn branch params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1,B2 preds=:
    v1 = CheckSmi v0 !fs
    v2 = Branch v1 [trueBlock=1, falseBlock=2]
  B1 succs=B3 preds=B0:
    v3 = Constant [value=1]
    v4 = Jump [targetBlock=3]
  B2 succs=B3 preds=B0:
    v5 = Constant [value=2]
    v6 = Jump [targetBlock=3]
  B3 succs= preds=B1,B2:
    v7 = Phi v3, v5
    v8 = Return v7
}
`;

  it("survives a print, parse and print cycle", () => {
    expect(printIR(parseIR(BRANCHING))).toBe(BRANCHING);
  });

  it("keeps phi inputs aligned with the predecessor order", () => {
    const graph = parseIR(BRANCHING);
    const merge = graph.blocks[3]!;
    expect(merge.predecessors.map((block) => block.id)).toEqual([1, 2]);
    expect(merge.phis[0]!.inputs.map((input) => input.props.value)).toEqual([1, 2]);
  });

  it("keeps the frame state marker attached to the guard", () => {
    const graph = parseIR(BRANCHING);
    expect(graph.blocks[0]!.nodes[0]!.frameState).not.toBeNull();
    expect(graph.blocks[0]!.nodes[1]!.frameState).toBeNull();
  });
});

describe("the text form as a pass fixture", () => {
  it("survives a graph the IR factories built the usual way", () => {
    const graph = new CFGFunction("built");
    const parameter = graph.addParameter(0);
    const entry = graph.addBlock();
    const taken = graph.addBlock();
    const skipped = graph.addBlock();
    link(entry, taken);
    link(entry, skipped);
    const guard = irCheckSmi(parameter);
    entry.addNode(guard);
    entry.addNode(irBranch(guard, taken, skipped));
    taken.addNode(irReturn(taken.addNode(irConstant(1))));
    skipped.addNode(irReturn(skipped.addNode(irConstant(0))));
    graph.rebuildUses();

    const text = printIR(graph);
    expect(text).not.toContain("<opaque>");
    expect(printIR(parseIR(text))).toBe(text);
  });

  it("reproduces the constants a parsed graph holds", () => {
    const graph = parseIR(STRAIGHT_LINE);
    const constants = graph.blocks[0]!.nodes.filter((node) => node.type === IR_CONSTANT);
    expect(constants.map((node) => node.props.value)).toEqual([2]);
  });
});

describe("carrying the state that hangs off the function itself", () => {
  function decorated(): CFGFunction {
    const graph = new CFGFunction("decorated");
    graph.addParameter(0);
    const block = graph.addBlock();
    block.addNode(irReturn(block.addNode(irConstant(1))));
    graph.isAsync = true;
    graph.internal = true;
    graph.gatheredArguments = 2;
    graph.classOwner = "Point";
    graph.declaredSignature = { params: ["int"], names: ["n"], returns: "int" };
    graph.calleeSignatures = new Map([["add", { params: ["int"], returns: "int" }]]);
    graph.emits = new Set(["Int32Add", "Return"]);
    graph.rebuildUses();
    return graph;
  }

  it("prints a graph attribute line only when something is set", () => {
    const bare = new CFGFunction("bare");
    bare.addBlock();
    expect(printIR(bare)).not.toContain("graph [");
    expect(printIR(decorated())).toContain("graph [");
  });

  it("restores every attribute it printed", () => {
    const original = decorated();
    const reparsed = parseIR(printIR(original));

    expect(reparsed.isAsync).toBe(true);
    expect(reparsed.internal).toBe(true);
    expect(reparsed.gatheredArguments).toBe(2);
    expect(reparsed.classOwner).toBe("Point");
    expect(reparsed.declaredSignature).toEqual(original.declaredSignature);
    expect(reparsed.calleeSignatures).toEqual(original.calleeSignatures);
    expect(reparsed.emits).toEqual(original.emits);
  });

  it("tells two graphs apart that differ only in an attribute", () => {
    const plain = decorated();
    plain.isAsync = false;
    expect(printIR(plain)).not.toBe(printIR(decorated()));
  });

  it("keeps every field of the declared field list identical across a round trip", () => {
    const original = decorated();
    const reparsed = parseIR(printIR(original));
    for (const field of GRAPH_FIELDS) {
      expect({ field, value: reparsed[field] }).toEqual({ field, value: original[field] });
    }
  });

  it("names an attribute it cannot represent instead of dropping it", () => {
    const graph = new CFGFunction("owned");
    graph.addBlock();
    class ClassTableStub {
      shapeOf(): null {
        return null;
      }
    }
    graph.classes = new ClassTableStub() as unknown as CFGFunction["classes"];
    const text = printIR(graph);

    expect(text).toContain("classes=<opaque:ClassTableStub>");
    expect(parseIR(text).classes).toBeInstanceOf(OpaqueValue);
    expect(printIR(parseIR(text))).toBe(text);
  });

  it("refuses an attribute the function does not have", () => {
    expect(() =>
      parseIR(`fn bad params=0 {
  graph [nonsense=true]
  B0 succs= preds=:
    v0 = Constant [value=1]
}
`),
    ).toThrow(/unknown graph attribute nonsense/);
  });
});

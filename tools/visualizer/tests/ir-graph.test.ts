import { describe, expect, it } from "vitest";
import { isBackEdge, layerBlocks, nodeByKey, parseGraphText } from "../src/services/ir-graph";

const LOOP = `fn work params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1 preds=:
    v1 = Constant [value=0]
    v2 = Jump [targetBlock=1]
  B1 loop-header succs=B2,B3 preds=B0,B2:
    v3 = Phi
    v4 = Branch v3
  B2 succs=B1 preds=B1:
    v5 = Int32Add v3, v1
    v6 = Jump [targetBlock=1]
  B3 succs= preds=B1:
    v7 = Return v3
}
`;

describe("reading a printed graph into a drawable model", () => {
  it("recovers the function name, parameters and every block", () => {
    const model = parseGraphText(LOOP)!;

    expect(model.name).toBe("work");
    expect(model.parameters.map((node) => node.key)).toEqual(["v0"]);
    expect(model.blocks.map((block) => block.label)).toEqual(["B0", "B1", "B2", "B3"]);
  });

  it("keeps each block's edges and marks the loop header", () => {
    const model = parseGraphText(LOOP)!;
    const header = model.blocks.find((block) => block.label === "B1")!;

    expect(header.isLoopHeader).toBe(true);
    expect(header.successors).toEqual(["B2", "B3"]);
    expect(header.predecessors).toEqual(["B0", "B2"]);
  });

  it("reads a node's opcode and value inputs, ignoring its properties", () => {
    const model = parseGraphText(LOOP)!;
    const add = model.blocks.find((block) => block.label === "B2")!.nodes[0]!;

    expect(add).toMatchObject({ key: "v5", opcode: "Int32Add", inputs: ["v3", "v1"] });
  });

  it("does not treat a property that names a block as a value input", () => {
    const model = parseGraphText(LOOP)!;
    const jump = model.blocks.find((block) => block.label === "B0")!.nodes[1]!;

    expect(jump.inputs).toEqual([]);
  });

  it("terminates and layers a graph that loops back on itself", () => {
    const model = parseGraphText(LOOP)!;
    const rows = layerBlocks(model);

    expect(rows.map((row) => row.map((block) => block.label))).toEqual([
      ["B0"],
      ["B1"],
      ["B2", "B3"],
    ]);
  });

  it("calls the edge back to the loop header a back edge", () => {
    const model = parseGraphText(LOOP)!;

    expect(isBackEdge(model, "B2", "B1")).toBe(true);
    expect(isBackEdge(model, "B1", "B3")).toBe(false);
  });

  it("answers null for text that is not a printed graph", () => {
    expect(parseGraphText("machine add:\n  movl %edi, %eax\n")).toBeNull();
  });
});

describe("finding a node so the graph can draw what feeds it", () => {
  it("finds a node inside a block by its value key", () => {
    const model = parseGraphText(LOOP)!;

    expect(nodeByKey(model, "v5")).toMatchObject({ opcode: "Int32Add", inputs: ["v3", "v1"] });
  });

  it("finds a parameter, which lives outside every block", () => {
    const model = parseGraphText(LOOP)!;

    expect(nodeByKey(model, "v0")?.opcode).toBe("Parameter");
  });

  it("answers null for a value the graph does not hold", () => {
    expect(nodeByKey(parseGraphText(LOOP)!, "v999")).toBeNull();
  });
});

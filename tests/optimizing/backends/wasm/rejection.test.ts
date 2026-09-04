import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  CFGInstruction,
  IR_NEW_REGEX,
  irCheckMap,
  irConstant,
  irFloat64Add,
  irInt32Add,
  irReturn,
  resetIRNodeIds,
  type Opcode,
} from "../../../../src/optimizing/ir/index.js";
import { WasmCodegen } from "../../../../src/optimizing/backends/wasm/codegen.js";
import { DominatorTree } from "../../../../src/optimizing/analyses/dominance.js";
import { LoopForest } from "../../../../src/optimizing/analyses/loops.js";
import { validateOptimizedGraph } from "../../../../src/optimizing/validation/graph-validator.js";

beforeEach(() => resetIRNodeIds());

function rejectionFor(build: (graph: CFGFunction) => void) {
  const graph = new CFGFunction("subject");
  build(graph);
  graph.rebuildUses();
  const forest = new LoopForest(graph, new DominatorTree(graph));
  return new WasmCodegen().compileRejection(graph, forest);
}

describe("wasm compile rejections are classified", () => {
  it("accepts a graph the backend can lower", () => {
    const rejection = rejectionFor((graph) => {
      const block = graph.addBlock();
      const left = irConstant(1);
      const right = irConstant(2);
      const sum = irInt32Add(left, right);
      block.addNode(left);
      block.addNode(right);
      block.addNode(sum);
      block.addNode(irReturn(sum));
    });

    expect(rejection).toBeNull();
  });

  it("reports a missing return as a malformed graph, not an unsupported one", () => {
    const rejection = rejectionFor((graph) => {
      const block = graph.addBlock();
      block.addNode(irConstant(1));
    });

    expect(rejection?.kind).toBe("malformed");
    expect(rejection?.reason).toBe("graph has no return");
  });

  it("reports a wrong input count as malformed", () => {
    const rejection = rejectionFor((graph) => {
      const block = graph.addBlock();
      const value = irConstant(1);
      const guard = irCheckMap(value, 1);
      guard.addInput(irConstant(2));
      block.addNode(value);
      block.addNode(guard);
      block.addNode(irReturn(guard));
    });

    expect(rejection?.kind).toBe("malformed");
    expect(rejection?.reason).toContain("expected 1");
  });

  it("reports an opcode the backend cannot emit as unsupported", () => {
    const rejection = rejectionFor((graph) => {
      const block = graph.addBlock();
      const unknown = new CFGInstruction("NotARealOpcode" as Opcode);
      block.addNode(unknown);
      block.addNode(irReturn(unknown));
    });

    expect(rejection?.kind).toBe("unsupported");
    expect(rejection?.reason).toContain("not supported by wasm backend");
  });

  it("separates a supported-but-unprofitable shape from a malformed one", () => {
    const rejection = rejectionFor((graph) => {
      const block = graph.addBlock();
      const receiver = irConstant(0);
      receiver.props.isThis = true;
      const guard = irCheckMap(receiver, 1);
      block.addNode(receiver);
      block.addNode(guard);
      block.addNode(irReturn(guard));
    });

    expect(rejection?.kind).toBe("unsupported");
    expect(rejection?.reason).toBe("property access on this receiver");
  });

  it("keeps a regex node supported so the classification is not a catch-all", () => {
    const rejection = rejectionFor((graph) => {
      const block = graph.addBlock();
      const regex = new CFGInstruction(IR_NEW_REGEX, { pattern: "a" });
      block.addNode(regex);
      block.addNode(irReturn(regex));
    });

    expect(rejection).toBeNull();
  });
});

describe("the graph validator is the net that replaced blanket use-list rebuilding", () => {
  function addingGraph() {
    const graph = new CFGFunction("adds");
    const block = graph.addBlock();
    const left = irConstant(1);
    const right = irConstant(2);
    const sum = irFloat64Add(left, right);
    block.addNode(left);
    block.addNode(right);
    const ret = irReturn(sum);
    block.addNode(sum);
    block.addNode(ret);
    graph.rebuildUses();
    return { graph, left, sum, ret };
  }

  it("accepts a graph whose use lists agree with its inputs", () => {
    const { graph } = addingGraph();

    expect(() => validateOptimizedGraph(graph)).not.toThrow();
  });

  it("rejects a use list that dropped a real use", () => {
    const { graph, left } = addingGraph();
    left.uses = [];

    expect(() => validateOptimizedGraph(graph)).toThrow(/missing use/);
  });

  it("rejects a use list that counts the same use twice", () => {
    const { graph, left, sum } = addingGraph();
    left.uses = [...left.uses, sum];

    expect(() => validateOptimizedGraph(graph)).toThrow(/mismatched use count/);
  });

  it("rejects a use recorded for a node that never consumed the value", () => {
    const { graph, left, ret } = addingGraph();
    left.uses = [...left.uses, ret];

    expect(() => validateOptimizedGraph(graph)).toThrow(/stale use/);
  });
});

describe("wasm declines handing back the receiver", () => {
  function receiverGraph(returnsThis: boolean) {
    return rejectionFor((graph) => {
      const block = graph.addBlock();
      const receiver = irConstant(undefined);
      receiver.props.isThis = true;
      block.addNode(receiver);
      const other = irConstant(1);
      block.addNode(other);
      block.addNode(irReturn(returnsThis ? receiver : other));
    });
  }

  it("declines a function whose answer is the receiver", () => {
    expect(String(receiverGraph(true)?.reason)).toContain("this receiver");
  });

  it("keeps compiling a function that only mentions the receiver", () => {
    expect(receiverGraph(false)).toBeNull();
  });
});

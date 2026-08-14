import { describe, expect, it } from "vitest";
import { solveMonotone, type FlowGraph } from "../../../src/optimizing/infra/dataflow.js";
import { setLattice } from "../../../src/optimizing/infra/lattice.js";

type Node = { readonly id: string };

function flowGraph(nodes: Node[], edges: Array<readonly [string, string]>): FlowGraph<Node> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const successors = new Map<Node, Node[]>(nodes.map((node) => [node, []]));
  const predecessors = new Map<Node, Node[]>(nodes.map((node) => [node, []]));
  for (const [from, to] of edges) {
    const source = byId.get(from)!;
    const target = byId.get(to)!;
    successors.get(source)!.push(target);
    predecessors.get(target)!.push(source);
  }
  return {
    nodes,
    entry: nodes[0]!,
    successors: (node) => successors.get(node)!,
    predecessors: (node) => predecessors.get(node)!,
  };
}

function generatorProblem(gen: Map<Node, number>) {
  return {
    direction: "forward" as const,
    lattice: setLattice<number>(),
    boundary: () => new Set<number>(),
    transfer: (node: Node, input: ReadonlySet<number>): ReadonlySet<number> => {
      const value = gen.get(node);
      if (value === undefined) return input;
      const output = new Set(input);
      output.add(value);
      return output;
    },
  };
}

describe("solveMonotone (forward)", () => {
  it("merges reaching values across the two arms of a diamond", () => {
    const entry = { id: "entry" };
    const left = { id: "left" };
    const right = { id: "right" };
    const merge = { id: "merge" };
    const graph = flowGraph(
      [entry, left, right, merge],
      [
        ["entry", "left"],
        ["entry", "right"],
        ["left", "merge"],
        ["right", "merge"],
      ],
    );

    const result = solveMonotone(graph, generatorProblem(new Map([[left, 1], [right, 2]])));

    expect([...result.stateAfter(merge)].sort()).toEqual([1, 2]);
    expect([...result.stateBefore(merge)].sort()).toEqual([1, 2]);
  });

  it("reaches a fixpoint over a back edge", () => {
    const entry = { id: "entry" };
    const head = { id: "head" };
    const body = { id: "body" };
    const exit = { id: "exit" };
    const graph = flowGraph(
      [entry, head, body, exit],
      [
        ["entry", "head"],
        ["head", "body"],
        ["body", "head"],
        ["head", "exit"],
      ],
    );

    const result = solveMonotone(graph, generatorProblem(new Map([[entry, 0], [body, 7]])));

    expect([...result.stateAfter(exit)].sort()).toEqual([0, 7]);
  });

  it("leaves an unreachable node at bottom", () => {
    const entry = { id: "entry" };
    const orphan = { id: "orphan" };
    const graph = flowGraph([entry, orphan], []);

    const result = solveMonotone(graph, generatorProblem(new Map([[orphan, 5]])));

    expect([...result.stateBefore(orphan)]).toEqual([]);
    expect([...result.stateAfter(orphan)]).toEqual([5]);
  });
});

describe("solveMonotone (backward)", () => {
  it("computes live variables from uses back to definitions", () => {
    const defineX = { id: "define-x" };
    const defineY = { id: "define-y" };
    const useX = { id: "use-x" };
    const graph = flowGraph(
      [defineX, defineY, useX],
      [
        ["define-x", "define-y"],
        ["define-y", "use-x"],
      ],
    );
    const use = new Map<Node, string[]>([[useX, ["x"]]]);
    const define = new Map<Node, string[]>([[defineX, ["x"]], [defineY, ["y"]]]);

    const result = solveMonotone<Node, ReadonlySet<string>>(graph, {
      direction: "backward",
      lattice: setLattice<string>(),
      boundary: () => new Set(),
      transfer: (node, liveOut) => {
        const live = new Set(liveOut);
        for (const killed of define.get(node) ?? []) live.delete(killed);
        for (const read of use.get(node) ?? []) live.add(read);
        return live;
      },
    });

    expect([...result.stateAfter(defineX)]).toEqual(["x"]);
    expect([...result.stateBefore(useX)]).toEqual(["x"]);
    expect([...result.stateBefore(defineX)]).toEqual([]);
  });
});

import type { Lattice } from "./lattice.js";
import { Worklist } from "./worklist.js";

export type FlowDirection = "forward" | "backward";

export interface FlowGraph<N> {
  readonly nodes: readonly N[];
  readonly entry: N;
  successors(node: N): readonly N[];
  predecessors(node: N): readonly N[];
}

export interface MonotoneProblem<N, F> {
  readonly direction: FlowDirection;
  readonly lattice: Lattice<F>;
  boundary(): F;
  transfer(node: N, input: F): F;
}

export interface DataflowResult<N, F> {
  stateBefore(node: N): F;
  stateAfter(node: N): F;
}

export function solveMonotone<N, F>(
  graph: FlowGraph<N>,
  problem: MonotoneProblem<N, F>,
): DataflowResult<N, F> {
  const { lattice } = problem;
  const forward = problem.direction === "forward";
  const stateBefore = new Map<N, F>();
  const stateAfter = new Map<N, F>();
  for (const node of graph.nodes) {
    stateBefore.set(node, lattice.bottom);
    stateAfter.set(node, lattice.bottom);
  }

  const inputSide = forward ? stateBefore : stateAfter;
  const outputSide = forward ? stateAfter : stateBefore;
  const sourcesOf = (node: N): readonly N[] =>
    forward ? graph.predecessors(node) : graph.successors(node);
  const sinksOf = (node: N): readonly N[] =>
    forward ? graph.successors(node) : graph.predecessors(node);

  const initial = new Set<N>();
  if (forward) {
    initial.add(graph.entry);
  } else {
    for (const node of graph.nodes) {
      if (graph.successors(node).length === 0) initial.add(node);
    }
  }

  const worklist = new Worklist<N>(graph.nodes);
  while (!worklist.isEmpty) {
    const node = worklist.take();
    if (node === undefined) break;
    let merged = initial.has(node) ? problem.boundary() : lattice.bottom;
    for (const source of sourcesOf(node)) {
      merged = lattice.join(merged, outputSide.get(source)!);
    }
    inputSide.set(node, merged);
    const produced = problem.transfer(node, merged);
    if (!lattice.equals(produced, outputSide.get(node)!)) {
      outputSide.set(node, produced);
      worklist.addAll(sinksOf(node));
    }
  }

  return {
    stateBefore: (node) => stateBefore.get(node) ?? lattice.bottom,
    stateAfter: (node) => stateAfter.get(node) ?? lattice.bottom,
  };
}

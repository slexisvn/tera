import { IR_CALL_KNOWN_FUNCTION, type CFGFunction } from "../ir/index.js";
import { calleeSymbolName } from "./call-signatures.js";

export interface CallReachability {
  callees(name: string): ReadonlySet<string>;
  reaches(from: string, to: string): boolean;
  overlaps(left: string, right: string): boolean;
}

const NOTHING: ReadonlySet<string> = new Set();

function calleesOf(graph: CFGFunction): ReadonlySet<string> {
  const called = new Set<string>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_CALL_KNOWN_FUNCTION) continue;
      const name = calleeSymbolName(node);
      if (name !== null) called.add(name);
    }
  }
  return called;
}

export function callReachability(graphs: readonly CFGFunction[]): CallReachability {
  const edges = new Map<string, ReadonlySet<string>>();
  for (const graph of graphs) edges.set(graph.name, calleesOf(graph));

  const closure = new Map<string, ReadonlySet<string>>();
  const reachedFrom = (name: string): ReadonlySet<string> => {
    const cached = closure.get(name);
    if (cached !== undefined) return cached;
    const reached = new Set<string>();
    const pending = [...(edges.get(name) ?? NOTHING)];
    for (const callee of pending) reached.add(callee);
    while (pending.length > 0) {
      for (const next of edges.get(pending.pop()!) ?? NOTHING) {
        if (reached.has(next)) continue;
        reached.add(next);
        pending.push(next);
      }
    }
    closure.set(name, reached);
    return reached;
  };

  const cones = new Map<string, ReadonlySet<string>>();
  const coneOf = (name: string): ReadonlySet<string> => {
    const cached = cones.get(name);
    if (cached !== undefined) return cached;
    const cone = new Set<string>([name, ...reachedFrom(name)]);
    cones.set(name, cone);
    return cone;
  };

  return {
    callees: (name) => edges.get(name) ?? NOTHING,
    reaches: (from, to) => reachedFrom(from).has(to),
    overlaps: (left, right) => {
      const [small, large] =
        coneOf(left).size <= coneOf(right).size
          ? [coneOf(left), coneOf(right)]
          : [coneOf(right), coneOf(left)];
      for (const name of small) {
        if (large.has(name)) return true;
      }
      return false;
    },
  };
}

export function markReentrantFunctions(
  graphs: readonly CFGFunction[],
  reachability: CallReachability = callReachability(graphs),
): number {
  let marked = 0;
  for (const graph of graphs) {
    if (!reachability.reaches(graph.name, graph.name)) continue;
    graph.reentrant = true;
    marked++;
  }
  return marked;
}

export function bottomUpCallOrder(graphs: readonly CFGFunction[]): readonly CFGFunction[] {
  const byName = new Map<string, CFGFunction>();
  for (const graph of graphs) byName.set(graph.name, graph);
  const edges = new Map<CFGFunction, readonly CFGFunction[]>();
  for (const graph of graphs) {
    const called: CFGFunction[] = [];
    for (const name of calleesOf(graph)) {
      const callee = byName.get(name);
      if (callee !== undefined && callee !== graph) called.push(callee);
    }
    edges.set(graph, called);
  }

  const ordered: CFGFunction[] = [];
  const state = new Map<CFGFunction, "visiting" | "placed">();
  const visit = (graph: CFGFunction): void => {
    if (state.has(graph)) return;
    state.set(graph, "visiting");
    for (const callee of edges.get(graph) ?? []) {
      if (state.get(callee) === "visiting") continue;
      visit(callee);
    }
    state.set(graph, "placed");
    ordered.push(graph);
  };
  for (const graph of graphs) visit(graph);
  return ordered;
}

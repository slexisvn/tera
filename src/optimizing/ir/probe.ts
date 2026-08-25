import type { GraphProbe } from "../infra/pass-trace.js";
import type { CFGFunction } from "./index.js";
import { printIR } from "./text.js";

export const cfgGraphProbe: GraphProbe<CFGFunction> = {
  nodeCount(graph) {
    let count = graph.parameters.length;
    for (const block of graph.blocks) count += block.nodes.length;
    return count;
  },
  dump(graph) {
    return printIR(graph);
  },
};

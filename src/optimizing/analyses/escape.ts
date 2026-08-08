import * as ir from "../ir/index.js";
import type { Lattice } from "../infra/lattice.js";
import { solveMonotone, type FlowGraph } from "../infra/dataflow.js";

type Value = ir.CFGInstruction;

export type Origin =
  | { readonly kind: "bottom" }
  | { readonly kind: "none" }
  | { readonly kind: "alloc"; readonly alloc: number }
  | { readonly kind: "top" };

const BOTTOM: Origin = { kind: "bottom" };
const NONE: Origin = { kind: "none" };
const TOP: Origin = { kind: "top" };

const ALLOCATIONS = new Set([ir.IR_NEW_OBJECT, ir.IR_NEW_ARRAY]);
const IDENTITY_GUARDS = new Set([ir.IR_CHECK_MAP, ir.IR_CHECK_ARRAY]);
const RECEIVER_ACCESSES = new Set([
  ir.IR_GENERIC_SET_PROP,
  ir.IR_GENERIC_GET_PROP,
  ir.IR_GENERIC_SET_INDEX,
  ir.IR_GENERIC_GET_INDEX,
  ir.IR_STORE_ELEMENT,
  ir.IR_LOAD_ELEMENT,
  ir.IR_STORE_FIELD,
  ir.IR_LOAD_FIELD,
]);

const originLattice: Lattice<Origin> = {
  bottom: BOTTOM,
  join(left, right) {
    if (left.kind === "bottom") return right;
    if (right.kind === "bottom") return left;
    if (left.kind === "top" || right.kind === "top") return TOP;
    if (left.kind === "none" || right.kind === "none") {
      return left.kind === "none" && right.kind === "none" ? NONE : TOP;
    }
    return left.alloc === right.alloc ? left : TOP;
  },
  equals(left, right) {
    if (left.kind !== right.kind) return false;
    return left.kind !== "alloc" || right.kind !== "alloc"
      ? true
      : left.alloc === right.alloc;
  },
};

function transfer(value: Value, incoming: Origin): Origin {
  if (ALLOCATIONS.has(value.type)) return { kind: "alloc", alloc: value.id };
  if (value.type === ir.IR_BLOCK_PARAM) return incoming;
  if (IDENTITY_GUARDS.has(value.type)) return incoming;
  return NONE;
}

function collectValues(graph: ir.CFGFunction): Value[] {
  const values: Value[] = [...graph.parameters];
  for (const block of graph.blocks) {
    for (const node of block.nodes) values.push(node);
  }
  return values;
}

function edgeArgConsumers(graph: ir.CFGFunction): Map<number, Value[]> {
  const consumers = new Map<number, Value[]>();
  for (const block of graph.blocks) {
    for (const successor of block.successors) {
      const args = block.getEdgeArgs(successor);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const param = successor.params[i];
        if (!arg || !param) continue;
        let list = consumers.get(arg.id);
        if (!list) {
          list = [];
          consumers.set(arg.id, list);
        }
        list.push(param);
      }
    }
  }
  return consumers;
}

export interface EscapeAnalysisResult {
  originOf(value: Value): Origin;
  aliasesOf(alloc: number): Value[];
  receiverUsesOf(alloc: number): Value[];
  escapes(alloc: number): boolean;
  virtualAllocations(): number[];
  flowsThroughPhi(alloc: number): boolean;
}

export function analyzeEscapes(graph: ir.CFGFunction): EscapeAnalysisResult {
  const values = collectValues(graph);
  const consumers = edgeArgConsumers(graph);
  const predecessorsOf = (value: Value): readonly Value[] =>
    value.type === ir.IR_BLOCK_PARAM ? ir.blockParamIncoming(value) : value.inputs;
  const successorsOf = (value: Value): readonly Value[] => {
    const fed = consumers.get(value.id);
    return fed ? [...value.uses, ...fed] : value.uses;
  };

  const flow: FlowGraph<Value> = {
    nodes: values,
    entry: values[0]!,
    predecessors: predecessorsOf,
    successors: successorsOf,
  };

  const solution = solveMonotone(flow, {
    direction: "forward",
    lattice: originLattice,
    boundary: () => BOTTOM,
    transfer,
  });

  const originOf = (value: Value): Origin => solution.stateAfter(value);

  const aliases = new Map<number, Value[]>();
  const phiAllocs = new Set<number>();
  for (const value of values) {
    const origin = originOf(value);
    if (origin.kind !== "alloc") continue;
    let list = aliases.get(origin.alloc);
    if (!list) {
      list = [];
      aliases.set(origin.alloc, list);
    }
    list.push(value);
    if (value.type === ir.IR_BLOCK_PARAM) phiAllocs.add(origin.alloc);
  }

  const escaped = new Set<number>();
  const receiverUses = new Map<number, Value[]>();
  const recordSafe = (alloc: number, use: Value): void => {
    let list = receiverUses.get(alloc);
    if (!list) {
      list = [];
      receiverUses.set(alloc, list);
    }
    list.push(use);
  };

  for (const [alloc, aliasList] of aliases) {
    for (const alias of aliasList) {
      const fed = consumers.get(alias.id);
      const useList = fed ? [...alias.uses, ...fed] : alias.uses;
      for (const use of useList) {
        if (use.type === ir.IR_BLOCK_PARAM) {
          const origin = originOf(use);
          if (origin.kind === "alloc" && origin.alloc === alloc) continue;
          escaped.add(alloc);
          continue;
        }
        if (IDENTITY_GUARDS.has(use.type) && use.inputs[0] === alias) {
          recordSafe(alloc, use);
          continue;
        }
        if (RECEIVER_ACCESSES.has(use.type) && use.inputs[0] === alias) {
          recordSafe(alloc, use);
          continue;
        }
        escaped.add(alloc);
      }
    }
  }

  return {
    originOf,
    aliasesOf: (alloc) => aliases.get(alloc) ?? [],
    receiverUsesOf: (alloc) => receiverUses.get(alloc) ?? [],
    escapes: (alloc) => escaped.has(alloc),
    virtualAllocations: () =>
      [...aliases.keys()].filter((alloc) => !escaped.has(alloc)),
    flowsThroughPhi: (alloc) => phiAllocs.has(alloc),
  };
}

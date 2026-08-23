import {
  CFGBlock,
  CFGFunction,
  CFGInstruction,
  isTerminator,
  IR_PARAMETER,
} from "./index.js";
import { BLOCK_TARGET_PROPS } from "./cfg-edit.js";
import type { Stamp } from "./graph-edit.js";

export interface BlockClone {
  readonly blockOf: ReadonlyMap<CFGBlock, CFGBlock>;
  readonly valueOf: ReadonlyMap<CFGInstruction, CFGInstruction>;
}

export function cloneBlocks(
  graph: CFGFunction,
  region: readonly CFGBlock[],
  stamp: Stamp,
): BlockClone {
  const blockOf = new Map<CFGBlock, CFGBlock>();
  const blockIds = new Map<number, number>();
  for (const block of region) {
    const copy = graph.addBlock();
    copy.isLoopHeader = block.isLoopHeader;
    blockOf.set(block, copy);
    blockIds.set(block.id, copy.id);
  }

  const valueOf = new Map<CFGInstruction, CFGInstruction>();
  for (const block of region) {
    for (const node of [...block.phis, ...block.nodes]) {
      if (valueOf.has(node)) continue;
      const copy = stamp(new CFGInstruction(node.type, { ...node.props }));
      copy.position = node.position;
      copy.rep = node.rep;
      copy.frameState = node.frameState;
      for (const key of BLOCK_TARGET_PROPS) {
        const id = copy.props[key];
        if (typeof id === "number") copy.props[key] = blockIds.get(id) ?? id;
      }
      valueOf.set(node, copy);
    }
  }
  const mapped = (value: CFGInstruction): CFGInstruction => valueOf.get(value) ?? value;

  const wired = new Set<CFGInstruction>();
  for (const block of region) {
    const copy = blockOf.get(block)!;
    for (const node of [...block.phis, ...block.nodes]) {
      const clone = mapped(node);
      if (wired.has(clone)) continue;
      wired.add(clone);
      clone.block = copy;
      for (const input of node.inputs) clone.addInput(mapped(input));
    }
    for (const phi of block.phis) copy.phis.push(mapped(phi));
    for (const node of block.nodes) {
      const clone = mapped(node);
      copy.nodes.push(clone);
      if (isTerminator(clone.type)) copy.terminator = clone;
    }
    copy.predecessors = block.predecessors.map((entered) => blockOf.get(entered) ?? entered);
    copy.successors = block.successors.map((left) => blockOf.get(left) ?? left);
  }

  for (const block of region) {
    const copy = blockOf.get(block)!;
    for (const entered of block.predecessors) {
      if (!blockOf.has(entered)) entered.successors.push(copy);
    }
    const leaving = new Map<CFGBlock, number>();
    for (const left of block.successors) {
      if (blockOf.has(left)) continue;
      const seen = leaving.get(left) ?? 0;
      leaving.set(left, seen + 1);
      const at = edgeIndexOf(left.predecessors, block, seen);
      left.predecessors.push(copy);
      for (const phi of left.phis) phi.addInput(mapped(phi.inputs[at]!));
    }
  }
  return { blockOf, valueOf };
}

function edgeIndexOf(
  predecessors: readonly CFGBlock[],
  from: CFGBlock,
  occurrence: number,
): number {
  let seen = 0;
  for (let at = 0; at < predecessors.length; at++) {
    if (predecessors[at] !== from) continue;
    if (seen === occurrence) return at;
    seen++;
  }
  throw new Error(`block B${from.id} is not the ${occurrence}th predecessor`);
}

export interface GraphClone {
  readonly graph: CFGFunction;
  readonly valueOf: ReadonlyMap<CFGInstruction, CFGInstruction>;
  readonly blockOf: ReadonlyMap<CFGBlock, CFGBlock>;
}

export function cloneGraph(source: CFGFunction, name: string): GraphClone {
  const graph = new CFGFunction(name);
  graph.classes = source.classes;
  graph.classOwner = source.classOwner;
  graph.calleeSignatures = source.calleeSignatures;
  graph.declaredSignature = source.declaredSignature;
  graph.isAsync = source.isAsync;
  graph.isGenerator = source.isGenerator;
  graph.receiver = source.receiver;
  graph.internal = source.internal;
  graph.recoversThrows = source.recoversThrows;
  graph.gatheredArguments = source.gatheredArguments;

  const blockOf = new Map<CFGBlock, CFGBlock>();
  const blockIds = new Map<number, number>();
  for (const block of source.blocks) {
    const copy = graph.addBlock();
    copy.isLoopHeader = block.isLoopHeader;
    blockOf.set(block, copy);
    blockIds.set(block.id, copy.id);
  }

  const valueOf = new Map<CFGInstruction, CFGInstruction>();
  const copyOf = (node: CFGInstruction): CFGInstruction => {
    const copy = new CFGInstruction(node.type, { ...node.props });
    copy.position = node.position;
    copy.rep = node.rep;
    for (const key of BLOCK_TARGET_PROPS) {
      const id = copy.props[key];
      if (typeof id === "number") copy.props[key] = blockIds.get(id) ?? id;
    }
    return copy;
  };

  for (const parameter of source.parameters) {
    const copy = graph.addParameter(Number(parameter.props.index ?? 0));
    copy.props = { ...parameter.props };
    valueOf.set(parameter, copy);
  }
  for (const block of source.blocks) {
    for (const phi of block.phis) valueOf.set(phi, copyOf(phi));
    for (const node of block.nodes) {
      if (valueOf.has(node)) continue;
      valueOf.set(node, copyOf(node));
    }
  }

  const mapped = (value: CFGInstruction): CFGInstruction => {
    const copy = valueOf.get(value);
    if (copy === undefined) {
      throw new Error(`cannot clone ${source.name}: ${value.type} is not part of the graph`);
    }
    return copy;
  };

  for (const block of source.blocks) {
    const target = blockOf.get(block)!;
    for (const predecessor of block.predecessors) {
      target.predecessors.push(blockOf.get(predecessor)!);
    }
    for (const successor of block.successors) {
      target.successors.push(blockOf.get(successor)!);
    }
    for (const phi of block.phis) {
      const copy = mapped(phi);
      copy.block = target;
      for (const input of phi.inputs) copy.addInput(mapped(input));
      target.phis.push(copy);
    }
    for (const node of block.nodes) {
      const copy = mapped(node);
      copy.block = target;
      if (node.type !== IR_PARAMETER) {
        for (const input of node.inputs) copy.addInput(mapped(input));
      }
      target.nodes.push(copy);
      if (isTerminator(copy.type)) target.terminator = copy;
    }
  }

  for (const copy of valueOf.values()) {
    for (const [key, value] of Object.entries(copy.props)) {
      if (value instanceof CFGInstruction) copy.props[key] = valueOf.get(value) ?? value;
    }
  }

  graph.entry = source.entry === null ? null : blockOf.get(source.entry) ?? null;
  graph.rebuildUses();
  return { graph, valueOf, blockOf };
}

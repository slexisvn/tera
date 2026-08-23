import {
  CFGBlock,
  CFGFunction,
  CFGInstruction,
  isTerminator,
  IR_PARAMETER,
} from "./index.js";
import { BLOCK_TARGET_PROPS } from "./cfg-edit.js";

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

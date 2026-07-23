import * as ir from "../ir/index.js";
import type { CFGBlock, CFGFunction, CFGInstruction } from "../ir/index.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";

function reachableFrom(header: CFGBlock): Set<number> {
  const reachable = new Set<number>();
  const stack: CFGBlock[] = [header];
  while (stack.length > 0) {
    const block = stack.pop()!;
    if (reachable.has(block.id)) continue;
    reachable.add(block.id);
    for (const successor of block.successors) stack.push(successor);
  }
  return reachable;
}

function rehomeConstant(node: CFGInstruction, header: CFGBlock): void {
  if (node.block) {
    node.block.nodes = node.block.nodes.filter((n) => n !== node);
  }
  node.block = header;
  header.nodes.splice(header.params.length, 0, node);
}

function substitute(
  graph: CFGFunction,
  frameStates: FrameState[],
  folds: Map<CFGInstruction, CFGInstruction>,
): void {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      for (let i = 0; i < node.inputs.length; i++) {
        const replacement = folds.get(node.inputs[i]);
        if (replacement) node.replaceInput(i, replacement);
      }
    }
    for (const args of block.edgeArgs.values()) {
      for (let i = 0; i < args.length; i++) {
        const replacement = folds.get(args[i]);
        if (replacement) args[i] = replacement;
      }
    }
  }
  for (const state of frameStates) {
    for (const [slot, value] of state.localValues) {
      const replacement = folds.get(value as CFGInstruction);
      if (replacement) state.localValues.set(slot, replacement as FrameValue);
    }
    for (let i = 0; i < state.stackValues.length; i++) {
      const replacement = folds.get(state.stackValues[i] as CFGInstruction);
      if (replacement) state.stackValues[i] = replacement as FrameValue;
    }
    const thisReplacement = folds.get(state.thisValue as CFGInstruction);
    if (thisReplacement) state.thisValue = thisReplacement as FrameValue;
  }
}

export function applyOsrTransform(
  graph: CFGFunction,
  offset: number,
  selfFn: RegisterCompiledFunction,
  frameStates: FrameState[],
): boolean {
  const candidate = graph.osrCandidates.get(offset);
  if (!candidate) return false;

  const header = graph.blocks.find((b) => b.id === candidate.headerBlockId);
  if (!header || !header.isLoopHeader) return false;
  if (header.params.length !== candidate.slots.length) return false;

  const reachable = reachableFrom(header);
  const latchPreds = header.predecessors.filter((p) => reachable.has(p.id));
  const entryPreds = header.predecessors.filter((p) => !reachable.has(p.id));
  if (latchPreds.length !== 1 || entryPreds.length === 0) return false;
  const latch = latchPreds[0];

  for (const block of graph.blocks) {
    if (!reachable.has(block.id)) continue;
    for (const node of block.nodes) {
      if (
        node.type === ir.IR_CALL_KNOWN_FUNCTION &&
        node.props.target === selfFn
      ) {
        return false;
      }
    }
  }

  const originalPhis = header.params.slice();
  const osrParams: CFGInstruction[] = [];
  const folds = new Map<CFGInstruction, CFGInstruction>();
  const variantPhis: CFGInstruction[] = [];
  const variantParams: CFGInstruction[] = [];

  for (let index = 0; index < originalPhis.length; index++) {
    const phi = originalPhis[index];
    const param = ir.irParameter(index);
    osrParams.push(param);
    const latchValue = phi.inputs[1];
    if (latchValue === phi) {
      folds.set(phi, param);
    } else {
      phi.replaceInput(0, param);
      variantPhis.push(phi);
      variantParams.push(param);
    }
  }

  substitute(graph, frameStates, folds);

  const latchEdgeArgs = latch.getEdgeArgs(header);
  const newLatchArgs: CFGInstruction[] = [];
  for (let index = 0; index < originalPhis.length; index++) {
    if (folds.has(originalPhis[index])) continue;
    newLatchArgs.push(latchEdgeArgs[index]);
  }

  header.params = variantPhis;
  header.nodes = header.nodes.filter((n) => !folds.has(n));
  for (let index = 0; index < variantPhis.length; index++) {
    variantPhis[index].props.index = index;
  }

  for (const block of graph.blocks) {
    if (!reachable.has(block.id)) continue;
    for (const node of block.nodes) {
      for (const input of node.inputs) {
        if (input.block === null) {
          if (input.type === ir.IR_PARAMETER && !osrParams.includes(input)) {
            return false;
          }
          continue;
        }
        if (reachable.has(input.block.id)) continue;
        if (input.type === ir.IR_CONSTANT) {
          rehomeConstant(input, header);
          continue;
        }
        return false;
      }
    }
  }

  for (const pred of entryPreds) {
    pred.successors = pred.successors.filter((s) => s.id !== header.id);
    pred.edgeArgs.delete(header.id);
  }

  const osrEntry = graph.addBlock();
  osrEntry.addNode(ir.irJump(header));
  header.predecessors = [];
  osrEntry.addSuccessor(header, variantParams);
  header.predecessors.push(latch);
  latch.setEdgeArgs(header, newLatchArgs);

  graph.entry = osrEntry;
  graph.parameters = osrParams;
  graph.parameterCount = osrParams.length;
  graph.osrParamSlots = candidate.slots.slice();

  graph.blocks = [
    osrEntry,
    ...graph.blocks.filter((b) => b.id !== osrEntry.id && reachable.has(b.id)),
  ];
  graph.rebuildUses();
  return true;
}

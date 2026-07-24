import * as ir from "../ir/index.js";
import { CFGInstruction } from "../ir/index.js";
import type { CFGBlock, CFGFunction } from "../ir/index.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";
import { computeDominators, dominates } from "./dominators.js";
import {
  sunkAllocationIds,
  visitFrameStateValues,
} from "./frame-state-values.js";
import { producesNumber } from "./repr-selection.js";

function carriesNumber(
  value: CFGInstruction | null | undefined,
  memo: Map<number, boolean>,
): boolean {
  if (!value) return false;
  if (producesNumber(value)) return true;
  if (value.type !== ir.IR_BLOCK_PARAM) return false;
  const cached = memo.get(value.id);
  if (cached !== undefined) return cached;
  memo.set(value.id, false);
  const carried = carriesNumber(value.inputs[1], memo);
  memo.set(value.id, carried);
  return carried;
}

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

function substituteFrameStateValues(
  state: FrameState,
  folds: Map<CFGInstruction, CFGInstruction>,
): void {
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
    substituteFrameStateValues(state, folds);
  }
}

function loopGuardSources(
  graph: CFGFunction,
  reachable: Set<number>,
  phis: CFGInstruction[],
): Map<CFGInstruction, CFGInstruction> {
  const phiSet = new Set(phis);
  const sources = new Map<CFGInstruction, CFGInstruction>();
  for (const block of graph.blocks) {
    if (!reachable.has(block.id)) continue;
    for (const node of block.nodes) {
      if (node.type !== ir.IR_CHECK_SMI && node.type !== ir.IR_CHECK_NUMBER) {
        continue;
      }
      const guarded = node.inputs[0];
      if (!guarded || !phiSet.has(guarded)) continue;
      const existing = sources.get(guarded);
      if (existing && existing.type === ir.IR_CHECK_SMI) continue;
      sources.set(guarded, node);
    }
  }
  return sources;
}

function templateFrameState(header: CFGBlock): FrameState | null {
  for (const node of header.nodes) {
    if (node.frameState) return node.frameState;
  }
  return null;
}

function entryFrameState(
  source: FrameState | null,
  frameStates: FrameState[],
  folds: Map<CFGInstruction, CFGInstruction>,
): FrameState | null {
  if (!source) return null;
  const state = source.clone();
  substituteFrameStateValues(state, folds);
  state.id = frameStates.length;
  frameStates.push(state);
  return state;
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
          ir.homeInstruction(input, header);
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
  const entryArgs = variantParams.slice();
  const guardSources = loopGuardSources(graph, reachable, variantPhis);
  const entryFolds = new Map<CFGInstruction, CFGInstruction>();
  for (let index = 0; index < variantPhis.length; index++) {
    entryFolds.set(variantPhis[index], variantParams[index]);
  }
  const headerState = templateFrameState(header);
  const carriedNumbers = new Map<number, boolean>();
  for (let index = 0; index < variantPhis.length; index++) {
    const phi = variantPhis[index];
    const source = guardSources.get(phi);
    const latchValue = phi.inputs[1];
    if (!source && !carriesNumber(latchValue, carriedNumbers)) continue;
    const sourceState = source?.frameState ?? headerState;
    if (!sourceState) continue;
    const param = variantParams[index];
    const guard =
      source && source.type === ir.IR_CHECK_SMI
        ? ir.irCheckSmi(param)
        : ir.irCheckNumber(param);
    guard.frameState = entryFrameState(sourceState, frameStates, entryFolds);
    osrEntry.addNode(guard);
    phi.replaceInput(0, guard);
    entryArgs[index] = guard;
  }
  osrEntry.addNode(ir.irJump(header));
  header.predecessors = [];
  osrEntry.addSuccessor(header, entryArgs);
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

export function repairFrameStateDominance(graph: CFGFunction): number {
  const idom = computeDominators(graph);
  const blockOf = new Map<CFGInstruction, CFGBlock>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) blockOf.set(node, block);
  }

  let placeholder: CFGInstruction | null = null;
  let repaired = 0;

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!node.frameState) continue;
      const sunkIds = sunkAllocationIds(node.frameState);
      visitFrameStateValues(node.frameState, (value, replace) => {
        if (!(value instanceof CFGInstruction)) return;
        if (value.type === ir.IR_PARAMETER || value.type === ir.IR_CONSTANT) {
          return;
        }
        if (sunkIds.has(value.id)) return;
        const defBlock = blockOf.get(value);
        if (defBlock && dominates(idom, defBlock, block)) return;
        if (!placeholder) placeholder = ir.irConstant(undefined);
        replace(placeholder as FrameValue);
        repaired++;
      });
    }
  }

  return repaired;
}

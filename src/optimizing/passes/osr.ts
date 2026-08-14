import * as ir from "../ir/index.js";
import { CFGInstruction } from "../ir/index.js";
import type { CFGBlock, CFGFunction } from "../ir/index.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";
import { computeDominators, dominates } from "../analyses/dominance-core.js";
import type { Loop, LoopForest } from "../analyses/loops.js";
import {
  sunkAllocationIds,
  visitFrameStateValues,
} from "../ir/frame-state-values.js";
import { producesNumber } from "./repr-selection.js";

function carriesNumber(
  value: CFGInstruction | null | undefined,
  memo: Map<number, boolean>,
): boolean {
  if (!value) return false;
  if (producesNumber(value)) return true;
  if (value.type !== ir.IR_PHI) return false;
  const cached = memo.get(value.id);
  if (cached !== undefined) return cached;
  memo.set(value.id, false);
  const carried = carriesNumber(value.inputs[value.inputs.length - 1], memo);
  memo.set(value.id, carried);
  return carried;
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
  }
  for (const state of frameStates) {
    substituteFrameStateValues(state, folds);
  }
}

function loopGuardSources(
  graph: CFGFunction,
  loopBlocks: ReadonlySet<CFGBlock>,
  phis: CFGInstruction[],
): Map<CFGInstruction, CFGInstruction> {
  const phiSet = new Set(phis);
  const sources = new Map<CFGInstruction, CFGInstruction>();
  for (const block of graph.blocks) {
    if (!loopBlocks.has(block)) continue;
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

function osrRegionBlocks(loop: Loop): Set<CFGBlock> {
  const blocks = new Set(loop.blocks);
  const stack = [...loop.exitBlocks];
  while (stack.length > 0) {
    const block = stack.pop()!;
    if (blocks.has(block)) continue;
    blocks.add(block);
    for (const successor of block.successors) stack.push(successor);
  }
  return blocks;
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
  forest: LoopForest,
): boolean {
  if (forest.irreducible) return false;
  const candidate = graph.osrCandidates.get(offset);
  if (!candidate) return false;

  const header = graph.blocks.find((b) => b.id === candidate.headerBlockId);
  if (!header || !forest.isHeader(header)) return false;
  const loop = forest.loopOf(header);
  if (!loop || loop.header !== header) return false;
  if (candidate.slots.length !== candidate.phiIds.length) return false;
  const candidatePhiIds = new Set(candidate.phiIds);
  if (candidatePhiIds.size !== candidate.phiIds.length) return false;

  const externalPredecessors = header.predecessors.filter(
    (predecessor) => !loop.blocks.has(predecessor),
  );
  const entry =
    loop.preheader ??
    (externalPredecessors.length === 1 ? externalPredecessors[0]! : null);
  if (loop.latches.length !== 1 || !entry) return false;
  const latch = loop.latches[0]!;
  const latchIndex = header.predecessors.indexOf(latch);
  const entryIndex = header.predecessors.indexOf(entry);
  if (latchIndex < 0 || entryIndex < 0) return false;
  const osrBlocks = osrRegionBlocks(loop);

  for (const block of graph.blocks) {
    if (!osrBlocks.has(block)) continue;
    for (const node of block.nodes) {
      if (
        node.type === ir.IR_CALL_KNOWN_FUNCTION &&
        node.props.target === selfFn
      ) {
        return false;
      }
    }
  }

  const originalPhis = header.phis.slice();
  const originalPhiById = new Map(originalPhis.map((phi) => [phi.id, phi]));
  const osrParams: CFGInstruction[] = [];
  const osrParamByPhi = new Map<CFGInstruction, CFGInstruction>();
  const osrPhiSet = new Set<CFGInstruction>();
  for (const phiId of candidate.phiIds) {
    const phi = originalPhiById.get(phiId);
    if (!phi) return false;
    const param = ir.irParameter(osrParams.length);
    osrParams.push(param);
    osrPhiSet.add(phi);
    osrParamByPhi.set(phi, param);
  }

  const folds = new Map<CFGInstruction, CFGInstruction>();
  const variantPhis: CFGInstruction[] = [];
  const osrVariantPhis: CFGInstruction[] = [];
  const osrVariantParams: CFGInstruction[] = [];

  for (const phi of originalPhis) {
    const latchValue = phi.inputs[latchIndex];
    if (osrPhiSet.has(phi)) {
      const param = osrParamByPhi.get(phi)!;
      if (latchValue === phi) {
        folds.set(phi, param);
      } else {
        phi.replaceInput(entryIndex, param);
        variantPhis.push(phi);
        osrVariantPhis.push(phi);
        osrVariantParams.push(param);
      }
      continue;
    }
    const entryValue = phi.inputs[entryIndex];
    if (!entryValue) return false;
    if (latchValue === phi) {
      folds.set(phi, entryValue);
    } else {
      variantPhis.push(phi);
    }
  }

  substitute(graph, frameStates, folds);

  header.phis = variantPhis;
  header.nodes = header.nodes.filter((n) => !folds.has(n));
  for (let index = 0; index < variantPhis.length; index++) {
    variantPhis[index].props.index = index;
  }

  for (const block of graph.blocks) {
    if (!osrBlocks.has(block)) continue;
    for (const node of block.nodes) {
      for (const input of node.inputs) {
        if (input.block === null) {
          if (input.type === ir.IR_PARAMETER && !osrParams.includes(input)) {
            return false;
          }
          continue;
        }
        if (osrBlocks.has(input.block)) continue;
        if (input.type === ir.IR_CONSTANT) {
          ir.homeInstruction(input, header);
          continue;
        }
        return false;
      }
    }
  }

  const osrEntry = graph.addBlock();
  const guardSources = loopGuardSources(graph, osrBlocks, osrVariantPhis);
  const entryFolds = new Map<CFGInstruction, CFGInstruction>();
  for (let index = 0; index < osrVariantPhis.length; index++) {
    entryFolds.set(osrVariantPhis[index], osrVariantParams[index]);
  }
  const headerState = templateFrameState(header);
  const carriedNumbers = new Map<number, boolean>();
  for (let index = 0; index < osrVariantPhis.length; index++) {
    const phi = osrVariantPhis[index];
    const source = guardSources.get(phi);
    const latchValue = phi.inputs[latchIndex];
    if (!source && !carriesNumber(latchValue, carriedNumbers)) continue;
    const sourceState = source?.frameState ?? headerState;
    if (!sourceState) continue;
    const param = osrVariantParams[index];
    const guard =
      source && source.type === ir.IR_CHECK_SMI
        ? ir.irCheckSmi(param)
        : ir.irCheckNumber(param);
    guard.frameState = entryFrameState(sourceState, frameStates, entryFolds);
    osrEntry.addNode(guard);
    phi.replaceInput(entryIndex, guard);
  }
  osrEntry.addNode(ir.irJump(header));

  entry.successors = entry.successors.filter((s) => s !== header);
  osrEntry.successors.push(header);
  header.predecessors[entryIndex] = osrEntry;

  graph.entry = osrEntry;
  graph.parameters = osrParams;
  graph.parameterCount = osrParams.length;
  graph.osrParamSlots = candidate.slots.slice();

  graph.blocks = [
    osrEntry,
    ...graph.blocks.filter((b) => b.id !== osrEntry.id && osrBlocks.has(b)),
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

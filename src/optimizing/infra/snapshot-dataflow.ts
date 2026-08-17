import type { CFGBlock, CFGFunction } from "../ir/index.js";
import { Worklist } from "./worklist.js";

export type SnapshotDirection = "forward" | "backward";

export interface SnapshotProblem<State> {
  readonly direction?: SnapshotDirection;
  empty(): State;
  clone(state: State): State;
  meet(left: State, right: State): State;
  equals(left: State, right: State): boolean;
  transfer(block: CFGBlock, inState: State): State;
  rewrite(block: CFGBlock, inState: State): number;
}

export function runSnapshotDataflow<State>(
  graph: CFGFunction,
  problem: SnapshotProblem<State>,
): number {
  if (!graph.entry) return 0;

  const reachable = reachableBlocks(graph.entry);
  const forward = problem.direction !== "backward";
  const inStates = new Map<CFGBlock, State | null>();
  const outStates = new Map<CFGBlock, State | null>();
  const inputStates = forward ? inStates : outStates;
  const outputStates = forward ? outStates : inStates;
  const boundaries = boundaryBlocks(reachable, graph.entry, forward);
  const boundarySet = new Set(boundaries);
  const worklist = new Worklist<CFGBlock>(boundaries);

  if (boundaries.length === 0) worklist.addAll(reachable);

  while (!worklist.isEmpty) {
    const block = worklist.take();
    if (!block) break;
    const input = mergeInputs(block, reachable, outputStates, boundarySet, forward, problem);
    if (!input) continue;
    inputStates.set(block, input);
    const output = problem.transfer(block, input);
    const previousOutput = outputStates.get(block) ?? null;
    if (previousOutput && problem.equals(output, previousOutput)) continue;
    outputStates.set(block, output);
    worklist.addAll(nextBlocks(block, reachable, forward));
  }

  let changed = 0;
  for (const block of reachable) {
    const input = inputStates.get(block) ?? null;
    if (!input) continue;
    changed += problem.rewrite(block, input);
  }

  if (changed > 0) graph.rebuildUses();
  return changed;
}

function reachableBlocks(entry: CFGBlock): Set<CFGBlock> {
  const reachable = new Set<CFGBlock>();
  const stack = [entry];
  while (stack.length > 0) {
    const block = stack.pop()!;
    if (reachable.has(block)) continue;
    reachable.add(block);
    for (let index = block.successors.length - 1; index >= 0; index--) {
      stack.push(block.successors[index]);
    }
  }
  return reachable;
}

function boundaryBlocks(
  reachable: ReadonlySet<CFGBlock>,
  entry: CFGBlock,
  forward: boolean,
): CFGBlock[] {
  if (forward) return [entry];
  const exits: CFGBlock[] = [];
  for (const block of reachable) {
    if (block.successors.every((successor) => !reachable.has(successor))) exits.push(block);
  }
  return exits;
}

function mergeInputs<State>(
  block: CFGBlock,
  reachable: ReadonlySet<CFGBlock>,
  outputStates: ReadonlyMap<CFGBlock, State | null>,
  boundarySet: ReadonlySet<CFGBlock>,
  forward: boolean,
  problem: SnapshotProblem<State>,
): State | null {
  let merged: State | null = boundarySet.has(block) ? problem.empty() : null;
  for (const source of sources(block, reachable, forward)) {
    const output = outputStates.get(source) ?? null;
    if (!output) continue;
    merged = merged ? problem.meet(merged, output) : problem.clone(output);
  }
  return merged;
}

function sources(
  block: CFGBlock,
  reachable: ReadonlySet<CFGBlock>,
  forward: boolean,
): CFGBlock[] {
  const list = forward ? block.predecessors : block.successors;
  return list.filter((candidate) => reachable.has(candidate));
}

function nextBlocks(
  block: CFGBlock,
  reachable: ReadonlySet<CFGBlock>,
  forward: boolean,
): CFGBlock[] {
  const list = forward ? block.successors : block.predecessors;
  return list.filter((candidate) => reachable.has(candidate));
}

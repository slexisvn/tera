import {
  CFGInstruction as IRValue,
  irBranch,
  IR_BRANCH,
  IR_JUMP,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { cloneBlocks } from "../ir/clone.js";
import { addPhi, rewriteBranchAsJump } from "../ir/cfg-edit.js";
import { visitFrameStateValues } from "../ir/frame-state-values.js";
import { nodeIdStamper, type Stamp } from "../ir/graph-edit.js";
import { metadataNumber } from "../ir/metadata.js";
import { eliminateUnreachableBlocks } from "./dce.js";
import type { Loop, LoopForest } from "../analyses/loops.js";

interface InvariantBranch {
  readonly test: CFGBlock;
  readonly condition: CFGInstruction;
  readonly onTrue: CFGBlock;
  readonly onFalse: CFGBlock;
}

function successorNamed(block: CFGBlock, branch: CFGInstruction, prop: string): CFGBlock | null {
  const id = metadataNumber(branch.props[prop]);
  if (id === null) return null;
  return block.successors.find((successor) => successor.id === id) ?? null;
}

function definedOutside(loop: Loop, value: CFGInstruction): boolean {
  return value.block === null || !loop.blocks.has(value.block);
}

function invariantBranchIn(loop: Loop): InvariantBranch | null {
  for (const test of loop.blocks) {
    const branch = test.getTerminator();
    if (branch === null || branch.type !== IR_BRANCH) continue;
    const condition = branch.inputs[0];
    if (condition === undefined || !definedOutside(loop, condition)) continue;
    const onTrue = successorNamed(test, branch, "trueBlock");
    const onFalse = successorNamed(test, branch, "falseBlock");
    if (onTrue === null || onFalse === null || onTrue === onFalse) continue;
    if (!loop.blocks.has(onTrue) || !loop.blocks.has(onFalse)) continue;
    return { test, condition, onTrue, onFalse };
  }
  return null;
}

function loopSize(loop: Loop): number {
  let size = 0;
  for (const block of loop.blocks) size += block.nodes.length;
  return size;
}

function routeEscapesThroughExit(
  graph: CFGFunction,
  loop: Loop,
  exit: CFGBlock,
  stamp: Stamp,
): void {
  const inside = (value: CFGInstruction): boolean =>
    value.block !== null && loop.blocks.has(value.block);
  const merged = new Map<CFGInstruction, CFGInstruction>();
  const mergeOf = (value: CFGInstruction): CFGInstruction => {
    const carried = merged.get(value);
    if (carried !== undefined) return carried;
    const phi = stamp(addPhi(exit, exit.predecessors.map(() => value)));
    merged.set(value, phi);
    return phi;
  };

  const alreadyMerged = new Set(exit.phis);
  for (const block of graph.blocks) {
    if (loop.blocks.has(block)) continue;
    for (const node of [...block.nodes]) {
      if (alreadyMerged.has(node)) continue;
      node.inputs.forEach((input, at) => {
        if (inside(input)) node.replaceInput(at, mergeOf(input));
      });
      visitFrameStateValues(node.frameState, (value, replace) => {
        if (value instanceof IRValue && inside(value)) replace(mergeOf(value));
      });
    }
  }
}

function enterEither(
  preheader: CFGBlock,
  header: CFGBlock,
  clonedHeader: CFGBlock,
  condition: CFGInstruction,
  stamp: Stamp,
): void {
  const jump = preheader.getTerminator();
  if (jump === null) return;
  preheader.nodes = preheader.nodes.filter((node) => node !== jump);
  const branch = stamp(irBranch(condition, header, clonedHeader));
  preheader.addNode(branch);
  preheader.successors = [header, clonedHeader];
}

function unswitchLoop(
  graph: CFGFunction,
  loop: Loop,
  found: InvariantBranch,
  stamp: Stamp,
): boolean {
  const preheader = loop.preheader;
  if (preheader === null || preheader.getTerminator()?.type !== IR_JUMP) return false;
  if (loop.exitBlocks.length !== 1) return false;
  const exit = loop.exitBlocks[0]!;
  if (exit.predecessors.some((entered) => !loop.blocks.has(entered))) return false;

  routeEscapesThroughExit(graph, loop, exit, stamp);
  const region = [...loop.blocks];
  const clone = cloneBlocks(graph, region, stamp);
  const clonedHeader = clone.blockOf.get(loop.header)!;
  const clonedTest = clone.blockOf.get(found.test)!;

  rewriteBranchAsJump(found.test, found.onTrue, found.onFalse);
  rewriteBranchAsJump(
    clonedTest,
    clone.blockOf.get(found.onFalse)!,
    clone.blockOf.get(found.onTrue)!,
  );
  enterEither(preheader, loop.header, clonedHeader, found.condition, stamp);
  return true;
}

export function loopUnswitching(
  graph: CFGFunction,
  forest: LoopForest,
  budget: number,
): number {
  if (budget <= 0) return 0;
  const stamp = nodeIdStamper(graph);
  let unswitched = 0;

  for (const loop of forest.loops()) {
    if (loopSize(loop) > budget) continue;
    const found = invariantBranchIn(loop);
    if (found === null) continue;
    if (!unswitchLoop(graph, loop, found, stamp)) continue;
    unswitched++;
  }

  if (unswitched > 0) {
    graph.rebuildUses();
    eliminateUnreachableBlocks(graph);
  }
  return unswitched;
}

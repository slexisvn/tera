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
import { remarks } from "../infra/pass-remarks.js";
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
  if (preheader === null || preheader.getTerminator()?.type !== IR_JUMP) {
    remarks.missed(
      found.condition,
      `loop B${loop.header.id} has no single preheader ending in a jump, so there is nowhere to put the hoisted test`,
    );
    return false;
  }
  if (loop.exitBlocks.length !== 1) {
    remarks.missed(
      found.condition,
      `loop B${loop.header.id} leaves through ${loop.exitBlocks.length} exits, and unswitching would have to duplicate every one of them`,
    );
    return false;
  }
  const exit = loop.exitBlocks[0]!;
  if (exit.predecessors.some((entered) => !loop.blocks.has(entered))) {
    remarks.missed(
      found.condition,
      `the exit of loop B${loop.header.id} is also reached from outside the loop, so the two copies could not agree on what flows out of it`,
    );
    return false;
  }

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
  if (budget <= 0) {
    remarks.analysis(
      null,
      "unswitching is switched off here: the budget is zero, either because this optimisation level does not pay for loop duplication or because the target can deoptimize instead",
    );
    return 0;
  }
  const stamp = nodeIdStamper(graph);
  let unswitched = 0;

  for (const loop of forest.loops()) {
    const size = loopSize(loop);
    if (size > budget) {
      remarks.missed(
        null,
        `loop B${loop.header.id} is ${size} nodes and the budget is ${budget}: duplicating it would cost more code than the branch it removes is worth`,
      );
      continue;
    }
    const found = invariantBranchIn(loop);
    if (found === null) {
      remarks.missed(
        null,
        `loop B${loop.header.id} has no branch whose condition is computed outside the loop, so there is nothing to hoist`,
      );
      continue;
    }
    if (!unswitchLoop(graph, loop, found, stamp)) continue;
    remarks.applied(
      found.condition,
      `hoisted this loop-invariant test out of B${loop.header.id}: the loop is now two copies, one per outcome, and neither tests it again`,
    );
    unswitched++;
  }

  if (unswitched > 0) {
    graph.rebuildUses();
    eliminateUnreachableBlocks(graph);
  }
  return unswitched;
}

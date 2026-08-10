import type { RuntimeValue } from "../../core/value/index.js";
import * as ir from "../ir/index.js";

import { tracer } from "../../core/tracing/index.js";
import { visitFrameStateValues } from "../ir/frame-state-values.js";
import { metadataNumber } from "../ir/metadata.js";
import type { DominatorTree } from "../analyses/dominance.js";
import type { LoopForest } from "../analyses/loops.js";
import type { ModRef } from "../analyses/mod-ref.js";
import type { PointsToResult } from "../analyses/points-to.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";

type LoopNode = ir.CFGInstruction;
type LoopBlock = ir.CFGBlock;
type LoopGraph = ir.CFGFunction;

type NodeBlockPair = { node: LoopNode; block: LoopBlock };

function nodeFromIr(value: ir.CFGInstruction): LoopNode {
  return value;
}

function isSideEffectFree(node: LoopNode): boolean {
  return ir.isMovable(node) && node.frameState === null;
}

const MAX_PEEL_NODES = 80;

export function hoistLoopInvariants(
  graph: LoopGraph,
  forest: LoopForest,
  pointsTo: PointsToResult,
  modRef: ModRef,
): number {
  const loops = [...forest.loops()].reverse();
  if (loops.length === 0) return 0;
  let hoistedCount = 0;
  const nodeToBlock = buildNodeToBlock(graph);

  for (const loop of loops) {
    if (!loop.preheader) continue;
    const header = loop.header;
    const bodyBlocks = loop.blocks;

    const memory = modRef.writesOf(bodyBlocks);
    const isHoistable = (node: LoopNode): boolean =>
      isSideEffectFree(node) && !modRef.mayReadFrom(node, memory);

    const isDefinedOutsideLoop = (node: LoopNode): boolean => {
      if (node.type === ir.IR_PARAMETER || node.type === ir.IR_CONSTANT) return true;
      const block = nodeToBlock.get(node.id);
      if (!block) return true;
      return !forest.contains(loop, block);
    };

    const invariantNodes: NodeBlockPair[] = [];
    const alreadyInvariant = new Set<number>();
    const candidates: NodeBlockPair[] = [];

    for (const block of bodyBlocks) {
      for (const node of block.nodes) {
        if (isHoistable(node)) candidates.push({ node, block });
      }
    }

    const worklist = [...candidates];
    while (worklist.length > 0) {
      const { node, block } = worklist.pop()!;
      if (alreadyInvariant.has(node.id)) continue;

      const allInputsOutside = node.inputs.every(
        (inp) => isDefinedOutsideLoop(inp) || alreadyInvariant.has(inp.id),
      );
      if (!allInputsOutside) continue;

      invariantNodes.push({ node, block });
      alreadyInvariant.add(node.id);
      for (const use of node.uses) {
        if (alreadyInvariant.has(use.id)) continue;
        const useBlock = nodeToBlock.get(use.id);
        if (!useBlock || !forest.contains(loop, useBlock)) continue;
        if (isHoistable(use)) worklist.push({ node: use, block: useBlock });
      }
    }

    if (invariantNodes.length === 0) continue;

    const preHeader = loop.preheader;

    const terminator = preHeader.getTerminator();
    let insertionPoint = terminator
      ? preHeader.nodes.indexOf(terminator)
      : preHeader.nodes.length;

    for (const { node, block } of invariantNodes) {
      block.nodes = block.nodes.filter((n) => n !== node);
      preHeader.nodes.splice(insertionPoint, 0, node);
      insertionPoint++;
      node.block = preHeader;
      nodeToBlock.set(node.id, preHeader);
      hoistedCount++;
      tracer.jitCompile(
        graph.name,
        `LICM: hoisted ${node.type} v${node.id} from B${block.id} to pre-header B${preHeader.id}`,
      );
    }
  }
  return hoistedCount;
}

export function loopUnrolling(
  graph: LoopGraph,
  forest: LoopForest,
  dominators: DominatorTree,
): number {
  let unrollCount = 0;
  const blockById = new Map<RuntimeValue, LoopBlock>();
  for (const block of graph.blocks) blockById.set(block.id, block);

  const loops = [...forest.loops()].reverse();
  for (const loop of loops) {
    const header = loop.header;
    const bodyBlocks = loop.blocks;

    let totalNodes = 0;
    for (const block of bodyBlocks) {
      totalNodes += block.nodes.length;
    }

    if (totalNodes > MAX_PEEL_NODES) continue;

    const headerTerm = header.getTerminator();
    if (!headerTerm || headerTerm.type !== ir.IR_BRANCH) continue;

    const trueBlockId = metadataNumber(headerTerm.props.trueBlock);
    const falseBlockId = metadataNumber(headerTerm.props.falseBlock);
    if (trueBlockId === null || falseBlockId === null) continue;
    const trueBlock = blockById.get(trueBlockId);
    const falseBlock = blockById.get(falseBlockId);
    if (!trueBlock || !falseBlock) continue;
    const trueIsExit = loop.exitBlocks.includes(trueBlock);
    const falseIsExit = loop.exitBlocks.includes(falseBlock);
    if (trueIsExit === falseIsExit) continue;
    const continueBlock = trueIsExit ? falseBlock : trueBlock;
    if (!forest.contains(loop, continueBlock)) continue;

    const preHeader = loop.preheader;
    if (!preHeader) continue;

    const preHeaderTerm = preHeader.getTerminator();
    let insertIdx = preHeaderTerm
      ? preHeader.nodes.indexOf(preHeaderTerm)
      : preHeader.nodes.length;
    const nodeToBlock = buildNodeToBlock(graph);
    const canUseInPreHeader = (value: LoopNode): boolean =>
      valueAvailableAtBlock(value, preHeader, nodeToBlock, dominators);
    const peeledNodes: { original: LoopNode; isLoad: boolean }[] = [];
    const peelableLoads = new Map<number, LoopNode>();

    for (const block of bodyBlocks) {
      for (const node of block.nodes) {
        if (node.type === ir.IR_LOAD_FIELD && node.inputs.every(canUseInPreHeader)) {
          peelableLoads.set(node.id, node);
        }
      }
    }

    const canResolveInput = (value: LoopNode): boolean =>
      canUseInPreHeader(value) || peelableLoads.has(value.id);

    for (const block of bodyBlocks) {
      for (const node of block.nodes) {
        if (node === headerTerm) continue;
        if (!isPeelableCheck(node)) continue;
        if (!node.frameState) continue;
        if (!node.inputs.every(canResolveInput)) continue;
        if (
          !frameStateAvailableAtBlock(
            node.frameState,
            preHeader,
            nodeToBlock,
            dominators,
          )
        )
          continue;
        for (const inp of node.inputs) {
          if (peelableLoads.has(inp.id) && !peeledNodes.some((p) => p.original === inp)) {
            peeledNodes.push({ original: inp, isLoad: true });
          }
        }
        peeledNodes.push({ original: node, isLoad: false });
      }
    }

    if (peeledNodes.length === 0) continue;

    const cloneMap = new Map<number, LoopNode>();
    for (const { original, isLoad } of peeledNodes) {
      const peeled = nodeFromIr(
        new ir.IRNode(original.type, { ...original.props }),
      );
      for (const inp of original.inputs) {
        peeled.addInput!(cloneMap.get(inp.id) || inp);
      }
      if (original.frameState) peeled.frameState = original.frameState;
      preHeader.nodes.splice(insertIdx, 0, peeled);
      insertIdx++;
      peeled.block = preHeader;
      cloneMap.set(original.id, peeled);

      tracer.jitCompile(
        graph.name,
        `LoopUnroll: peeled ${original.type} v${original.id} into pre-header B${preHeader.id}`,
      );
    }

    unrollCount++;
  }

  return unrollCount;
}

function buildNodeToBlock(graph: LoopGraph): Map<number, LoopBlock> {
  const nodeToBlock = new Map<number, LoopBlock>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) nodeToBlock.set(node.id, block);
  }
  return nodeToBlock;
}

function isPeelableCheck(node: LoopNode): boolean {
  return (
    node.type === ir.IR_CHECK_SMI ||
    node.type === ir.IR_CHECK_MAP ||
    node.type === ir.IR_CHECK_NUMBER ||
    node.type === ir.IR_CHECK_ARRAY
  );
}

function valueAvailableAtBlock(
  value: LoopNode | null | undefined,
  block: LoopBlock,
  nodeToBlock: Map<number, LoopBlock>,
  dominators: DominatorTree,
): boolean {
  if (!value) return true;
  if (value.type === ir.IR_PARAMETER || value.type === ir.IR_CONSTANT) return true;
  const owner = nodeToBlock.get(value.id);
  if (!owner) return false;
  return dominators.dominates(owner, block);
}

function frameStateAvailableAtBlock(
  frameState: FrameState,
  block: LoopBlock,
  nodeToBlock: Map<number, LoopBlock>,
  dominators: DominatorTree,
): boolean {
  let available = true;
  visitFrameStateValues(frameState, (value) => {
    if (isLoopNode(value) && !valueAvailableAtBlock(value, block, nodeToBlock, dominators))
      available = false;
  });
  return available;
}

function isLoopNode(value: FrameValue | null | undefined): value is LoopNode {
  return value instanceof ir.CFGInstruction;
}

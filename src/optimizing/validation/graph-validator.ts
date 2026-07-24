import {
  IR_BLOCK_PARAM,
  IR_BRANCH,
  IR_CONSTANT,
  IR_DEOPTIMIZE,
  irRequiresFrameState,
  IR_JUMP,
  IR_PARAMETER,
  IR_RETURN,
  CFGInstruction,
  type CFGBlock,
  type CFGFunction,
} from "../ir/index.js";
import {
  computeDominators,
  dominates,
  type DominatorBlock,
} from "../passes/dominators.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";
import { sunkAllocationIds } from "../passes/frame-state-values.js";

type ValidationNode = CFGInstruction;
type ValidationBlock = CFGBlock;
type ValidationGraph = CFGFunction;
type ValidationFrameState = FrameState;

interface ValueLocation {
  block: ValidationBlock | null;
  index: number;
  parameter: boolean;
}

export class GraphValidationError extends Error {
  errors: string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "GraphValidationError";
    this.errors = errors;
  }
}

export function validateOptimizedGraph(
  graph: ValidationGraph,
  frameStates: ValidationFrameState[] = [],
): true {
  const errors: string[] = [];
  if (!graph || !Array.isArray(graph.blocks) || graph.blocks.length === 0) {
    errors.push("graph is empty");
  } else {
    const dominators = computeDominators(graph);
    const locations = valueLocations(graph);
    validateFrameStates(graph, frameStates, errors);
    validateNodeOwnership(graph, errors);
    validateBlockParams(graph, errors);
    validateControlFlow(graph, errors);
    validateUseDefDominanceWith(graph, dominators, locations, errors);
    validateUseLists(graph, errors);
    validateFrameStateValueDominanceWith(graph, dominators, locations, errors);
  }
  if (errors.length > 0) throw new GraphValidationError(errors);
  return true;
}

function validateNodeOwnership(
  graph: ValidationGraph,
  errors: string[],
): void {
  for (const block of graph.blocks) {
    const nodeSet = new Set(block.nodes);
    for (const node of block.nodes) {
      if (node.type === IR_PARAMETER || node.type === IR_CONSTANT) continue;
      if (node.block !== block) {
        const owner = node.block ? `B${node.block.id}` : "none";
        errors.push(`B${block.id} v${node.id} ${node.type} has owner ${owner}`);
      }
    }
    for (const param of block.params) {
      if (!nodeSet.has(param)) {
        errors.push(
          `B${block.id} v${param.id} block param is missing from node list`,
        );
      }
    }
  }
}

function validateControlFlow(graph: ValidationGraph, errors: string[]): void {
  const blockIds = new Set(graph.blocks.map((block) => block.id));
  for (const block of graph.blocks) {
    validateBlockEdges(block, errors);
    const terminatorIndex = block.nodes.findIndex((node) => isTerminator(node));
    const terminator = block.getTerminator
      ? block.getTerminator()
      : terminatorIndex >= 0
        ? block.nodes[terminatorIndex]
        : null;
    if (terminatorIndex >= 0 && terminatorIndex !== block.nodes.length - 1) {
      errors.push(
        `B${block.id} has nodes after terminator v${block.nodes[terminatorIndex].id}`,
      );
    }
    if (!terminator && block.successors.length > 0) {
      errors.push(`B${block.id} has successors without a terminator`);
      continue;
    }
    if (!terminator) continue;

    if (terminator.type === IR_BRANCH) {
      validateBranchTerminator(block, terminator, blockIds, errors);
    } else if (terminator.type === IR_JUMP) {
      validateJumpTerminator(block, terminator, blockIds, errors);
    } else if (
      terminator.type === IR_RETURN ||
      terminator.type === IR_DEOPTIMIZE
    ) {
      if (block.successors.length !== 0) {
        errors.push(
          `B${block.id} ${terminator.type} terminator has successors`,
        );
      }
    }
  }
}

function validateBlockEdges(block: ValidationBlock, errors: string[]): void {
  const successorIds = new Set(
    block.successors.map((successor) => successor.id),
  );
  const predecessorSet = new Set(block.predecessors);
  for (const successor of block.successors) {
    const succPredSet = new Set(successor.predecessors);
    if (!succPredSet.has(block)) {
      errors.push(
        `B${block.id}->B${successor.id} successor is missing predecessor`,
      );
    }
  }
  for (const predecessor of block.predecessors) {
    const predSuccSet = new Set(predecessor.successors);
    if (!predSuccSet.has(block)) {
      errors.push(
        `B${predecessor.id}->B${block.id} predecessor is missing successor`,
      );
    }
  }
  if (block.edgeArgs) {
    for (const targetId of block.edgeArgs.keys()) {
      if (!successorIds.has(targetId)) {
        errors.push(
          `B${block.id}->B${targetId} has edge args without successor`,
        );
      }
    }
  }
}

function validateBranchTerminator(
  block: ValidationBlock,
  terminator: ValidationNode,
  blockIds: Set<number>,
  errors: string[],
): void {
  const expectedIds = new Set([
    terminator.props.trueBlock as number,
    terminator.props.falseBlock as number,
  ]);
  for (const id of expectedIds) {
    if (!blockIds.has(id))
      errors.push(`B${block.id} branch targets missing block ${id}`);
  }
  const successorIds = new Set(block.successors.map((successor) => successor.id));
  for (const id of expectedIds) {
    if (!successorIds.has(id))
      errors.push(`B${block.id} branch target B${id} is not a successor`);
  }
  for (const id of successorIds) {
    if (!expectedIds.has(id))
      errors.push(`B${block.id} has non-branch successor B${id}`);
  }
}

function validateJumpTerminator(
  block: ValidationBlock,
  terminator: ValidationNode,
  blockIds: Set<number>,
  errors: string[],
): void {
  const targetId = terminator.props.targetBlock as number;
  if (!blockIds.has(targetId))
    errors.push(`B${block.id} jump targets missing block ${targetId}`);
  if (block.successors.length !== 1 || block.successors[0].id !== targetId) {
    errors.push(
      `B${block.id} jump target B${targetId} does not match successors`,
    );
  }
}

function isTerminator(node: ValidationNode): boolean {
  return (
    node.type === IR_BRANCH ||
    node.type === IR_JUMP ||
    node.type === IR_RETURN ||
    node.type === IR_DEOPTIMIZE
  );
}

function validateFrameStates(
  graph: ValidationGraph,
  frameStates: ValidationFrameState[],
  errors: string[],
): void {
  const frameStateSet = new Set(frameStates);
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!irRequiresFrameState(node)) continue;
      if (!node.frameState) {
        errors.push(
          `B${block.id} v${node.id} ${node.type} missing frame state`,
        );
        continue;
      }
      if ((node.frameState.id ?? -1) < 0) {
        errors.push(
          `B${block.id} v${node.id} ${node.type} has unassigned frame state`,
        );
      }
      if (frameStates.length > 0 && !frameStateSet.has(node.frameState)) {
        errors.push(
          `B${block.id} v${node.id} ${node.type} references foreign frame state`,
        );
      }
    }
  }
}

function validateBlockParams(graph: ValidationGraph, errors: string[]): void {
  for (const block of graph.blocks) {
    for (const pred of block.predecessors) {
      const edgeArgs = pred.getEdgeArgs(block);
      if (edgeArgs.length !== block.params.length) {
        errors.push(
          `B${pred.id}->B${block.id} has ${edgeArgs.length} edge args for ${block.params.length} block params`,
        );
      }
      for (let i = 0; i < edgeArgs.length; i++) {
        if (!edgeArgs[i]) {
          errors.push(`B${pred.id}->B${block.id} edge arg ${i} is empty`);
        }
      }
    }
    for (const param of block.params) {
      if (param.inputs.length === 0 && block.predecessors.length > 0) {
        errors.push(
          `B${block.id} v${param.id} block param has no incoming values`,
        );
      }
      if (
        param.inputs.length !== block.predecessors.length &&
        block.predecessors.length > 0
      ) {
        errors.push(
          `B${block.id} v${param.id} has ${param.inputs.length} inputs for ${block.predecessors.length} predecessors`,
        );
      }
      for (let i = 0; i < block.predecessors.length; i++) {
        const pred = block.predecessors[i];
        const edgeArgs = pred.getEdgeArgs(block);
        const paramIndex = param.props.index as number;
        if (
          edgeArgs.length === block.params.length &&
          edgeArgs[paramIndex] !== param.inputs[i]
        ) {
          errors.push(
            `B${block.id} v${param.id} input ${i} does not match B${pred.id}->B${block.id} edge arg ${String(param.props.index)}`,
          );
        }
      }
    }
  }
}

function validateUseLists(graph: ValidationGraph, errors: string[]): void {
  const values = graphValues(graph);
  const valueSet = new Set(values);
  const expected = new Map<ValidationNode, Map<ValidationNode, number>>(
    values.map((value) => [value, new Map<ValidationNode, number>()]),
  );

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      for (const input of node.inputs) {
        if (!valueSet.has(input)) continue;
        incrementUse(expected.get(input)!, node);
      }
    }
  }

  for (const value of values) {
    const expectedUses = expected.get(value)!;
    const actualUses = countUses(value.uses || []);
    for (const [use, count] of expectedUses) {
      if ((actualUses.get(use) || 0) !== count) {
        errors.push(
          `v${value.id} ${value.type} missing use by v${use.id} ${use.type}`,
        );
      }
    }
    for (const [use, count] of actualUses) {
      if (!expectedUses.has(use)) {
        errors.push(
          `v${value.id} ${value.type} has stale use by v${use.id} ${use.type}`,
        );
      } else if (expectedUses.get(use) !== count) {
        errors.push(
          `v${value.id} ${value.type} has mismatched use count for v${use.id} ${use.type}`,
        );
      }
    }
  }
}

function graphValues(graph: ValidationGraph): ValidationNode[] {
  const values: ValidationNode[] = [];
  const seen = new Set<ValidationNode>();
  for (const param of graph.parameters || []) {
    if (!seen.has(param)) {
      values.push(param);
      seen.add(param);
    }
  }
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!seen.has(node)) {
        values.push(node);
        seen.add(node);
      }
    }
  }
  return values;
}

function incrementUse(
  uses: Map<ValidationNode, number>,
  use: ValidationNode,
): void {
  uses.set(use, (uses.get(use) || 0) + 1);
}

function countUses(uses: ValidationNode[]): Map<ValidationNode, number> {
  const counts = new Map<ValidationNode, number>();
  for (const use of uses) incrementUse(counts, use);
  return counts;
}

function validateUseDefDominanceWith(
  graph: ValidationGraph,
  dominators: Map<DominatorBlock, DominatorBlock>,
  locations: Map<ValidationNode, ValueLocation>,
  errors: string[],
): void {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_BLOCK_PARAM) continue;
      for (const input of node.inputs) {
        validateInputAvailable(
          input,
          block,
          node,
          locations,
          dominators,
          errors,
        );
      }
    }

    for (const successor of block.successors) {
      const edgeArgs = block.getEdgeArgs(successor);
      for (let i = 0; i < edgeArgs.length; i++) {
        validateEdgeArgAvailable(
          edgeArgs[i],
          block,
          successor,
          i,
          locations,
          dominators,
          errors,
        );
      }
    }
  }
}

function validateFrameStateValueDominanceWith(
  graph: ValidationGraph,
  dominators: Map<DominatorBlock, DominatorBlock>,
  locations: Map<ValidationNode, ValueLocation>,
  errors: string[],
): void {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!node.frameState) continue;
      validateFrameStateValues(
        node.frameState,
        block,
        node,
        locations,
        dominators,
        errors,
        new Set(),
      );
    }
  }
}

function validateFrameStateValues(
  frameState: ValidationFrameState | null | undefined,
  useBlock: ValidationBlock,
  useNode: ValidationNode,
  locations: Map<ValidationNode, ValueLocation>,
  dominators: Map<DominatorBlock, DominatorBlock>,
  errors: string[],
  seen: Set<ValidationFrameState>,
): void {
  if (!frameState || seen.has(frameState)) return;
  seen.add(frameState);
  const sunkIds = sunkAllocationIds(frameState as never);

  for (const [slot, value] of frameState.localValues || []) {
    validateFrameStateValueAvailable(
      value,
      `local ${slot}`,
      useBlock,
      useNode,
      locations,
      dominators,
      errors,
      sunkIds,
    );
  }

  const stackValues = frameState.stackValues || [];
  for (let i = 0; i < stackValues.length; i++) {
    validateFrameStateValueAvailable(
      stackValues[i],
      `stack ${i}`,
      useBlock,
      useNode,
      locations,
      dominators,
      errors,
      sunkIds,
    );
  }

  if (frameState.thisValue) {
    validateFrameStateValueAvailable(
      frameState.thisValue,
      "this",
      useBlock,
      useNode,
      locations,
      dominators,
      errors,
      sunkIds,
    );
  }

  validateFrameStateValues(
    frameState.callerFrameState,
    useBlock,
    useNode,
    locations,
    dominators,
    errors,
    seen,
  );
}

function validateFrameStateValueAvailable(
  value: FrameValue | null | undefined,
  label: string,
  useBlock: ValidationBlock,
  useNode: ValidationNode,
  locations: Map<ValidationNode, ValueLocation>,
  dominators: Map<DominatorBlock, DominatorBlock>,
  errors: string[],
  sunkIds?: Set<number>,
): void {
  if (!(value instanceof CFGInstruction)) return;
  if (sunkIds?.has(value.id)) return;
  const beforeCount = errors.length;
  validateInputAvailable(
    value,
    useBlock,
    useNode,
    locations,
    dominators,
    errors,
  );
  if (errors.length > beforeCount) {
    errors[errors.length - 1] =
      `B${useBlock.id} v${useNode.id} frame state ${label} ${errors[errors.length - 1]}`;
  }
}

function valueLocations(graph: ValidationGraph): Map<ValidationNode, ValueLocation> {
  const locations = new Map<ValidationNode, ValueLocation>();
  for (const param of graph.parameters || []) {
    locations.set(param, { block: null, index: -1, parameter: true });
  }
  for (const block of graph.blocks) {
    for (let index = 0; index < block.nodes.length; index++) {
      locations.set(block.nodes[index], { block, index, parameter: false });
    }
  }
  return locations;
}

function validateInputAvailable(
  input: ValidationNode | null | undefined,
  useBlock: ValidationBlock,
  useNode: ValidationNode,
  locations: Map<ValidationNode, ValueLocation>,
  dominators: Map<DominatorBlock, DominatorBlock>,
  errors: string[],
): void {
  if (!input) return;
  if (input.type === IR_PARAMETER || input.type === IR_CONSTANT) return;
  const location = locations.get(input);
  if (!location) {
    errors.push(
      `B${useBlock.id} v${useNode.id} uses v${input.id} with no definition`,
    );
    return;
  }
  if (location.parameter) return;
  if (location.block === useBlock) {
    const useIndex = locations.get(useNode)!.index;
    if (location.index >= useIndex) {
      errors.push(
        `B${useBlock.id} v${useNode.id} ${useNode.type} uses v${input.id} ${input.type} before its definition`,
      );
    }
    return;
  }
  if (!location.block) return;
  if (!dominates(dominators, location.block, useBlock)) {
    errors.push(
      `B${useBlock.id} v${useNode.id} uses v${input.id} from B${location.block.id} which does not dominate B${useBlock.id}`,
    );
  }
}

function validateEdgeArgAvailable(
  arg: ValidationNode | null | undefined,
  predBlock: ValidationBlock,
  successor: ValidationBlock,
  argIndex: number,
  locations: Map<ValidationNode, ValueLocation>,
  dominators: Map<DominatorBlock, DominatorBlock>,
  errors: string[],
): void {
  if (!arg) return;
  if (arg.type === IR_PARAMETER || arg.type === IR_CONSTANT) return;
  const location = locations.get(arg);
  if (!location) {
    errors.push(
      `B${predBlock.id}->B${successor.id} edge arg ${argIndex} uses v${arg.id} with no definition`,
    );
    return;
  }
  if (location.parameter) return;
  if (location.block === predBlock) return;
  if (!location.block) return;
  if (!dominates(dominators, location.block, predBlock)) {
    errors.push(
      `B${predBlock.id}->B${successor.id} edge arg ${argIndex} uses v${arg.id} from B${location.block.id} which is unavailable at predecessor`,
    );
  }
}

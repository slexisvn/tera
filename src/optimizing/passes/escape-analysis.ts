import * as ir from "../ir/index.js";

import { tracer } from "../../core/tracing/index.js";
import {
  computeDominators,
  buildDominatorTree,
  dominates,
} from "./dominators.js";
import { replaceGraphFrameStateValue } from "./frame-state-values.js";
import { detachInputs } from "./graph-edit.js";

type EscapeNode = ir.CFGInstruction;
type EscapeBlock = ir.CFGBlock;
type EscapeGraph = ir.CFGFunction;

type ValueState = Map<ir.IRMetadataValue, EscapeNode>;

function nodeFromIr(value: ir.CFGInstruction): EscapeNode {
  return value;
}

export function escapeAnalysisAndScalarReplacement(graph: EscapeGraph): number {
  let scalarReplCount = 0;
  const dom = computeDominators(graph);
  const { children } = buildDominatorTree(graph, dom);

  const blockOf = new Map<EscapeNode, EscapeBlock>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      blockOf.set(node, block);
    }
  }

  const allocations: EscapeNode[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === ir.IR_NEW_OBJECT || node.type === ir.IR_NEW_ARRAY) {
        allocations.push(node);
      }
    }
  }

  for (const alloc of allocations) {
    const allocBlock = blockOf.get(alloc);
    if (!allocBlock) continue;

    let escapes = false;
    const safeUses = new Set<EscapeNode>();
    const aliases = new Set<EscapeNode>([alloc]);
    const worklist: EscapeNode[] = [alloc];

    while (worklist.length > 0 && !escapes) {
      const ref = worklist.pop()!;
      for (const use of [...ref.uses]) {
        if (safeUses.has(use)) continue;
        if (
          isPropertyUse(use, aliases) ||
          isElementUse(use, aliases) ||
          isFieldUse(use, aliases)
        ) {
          safeUses.add(use);
        } else if (
          isReferenceGuard(use, aliases) ||
          isSameReferencePhi(use, aliases)
        ) {
          safeUses.add(use);
          aliases.add(use);
          worklist.push(use);
        } else {
          escapes = true;
          break;
        }
      }
    }

    if (escapes) continue;

    let allDominated = true;
    for (const use of safeUses) {
      const useBlock = blockOf.get(use);
      if (!useBlock) {
        allDominated = false;
        break;
      }
      if (!dominates(dom, allocBlock, useBlock)) {
        allDominated = false;
        break;
      }
    }

    if (!allDominated) continue;

    const toDelete = new Set<number>([...aliases].map((node) => node.id));

    let arrayLength: number | null = null;
    if (alloc.type === ir.IR_NEW_ARRAY) {
      arrayLength = alloc.inputs.length;
      for (const use of safeUses) {
        if (
          (use.type === ir.IR_STORE_ELEMENT ||
            use.type === ir.IR_GENERIC_SET_INDEX) &&
          use.inputs[1] &&
          use.inputs[1].type === ir.IR_CONSTANT &&
          typeof use.inputs[1].props.value === "number"
        ) {
          arrayLength = Math.max(arrayLength, use.inputs[1].props.value + 1);
        }
      }
    }

    const processBlock = (
      block: EscapeBlock,
      propState: ValueState,
      offsetState: ValueState,
    ): void => {
      for (let i = 0; i < block.nodes.length; i++) {
        const node = block.nodes[i];
        if (node === alloc) continue;
        if (!safeUses.has(node)) continue;

        if (
          node.type === ir.IR_CHECK_MAP ||
          node.type === ir.IR_CHECK_ARRAY ||
          node.type === ir.IR_PHI
        ) {
          toDelete.add(node.id);
        } else if (
          node.type === ir.IR_STORE_FIELD &&
          toDelete.has(node.inputs[0]?.id)
        ) {
          const offset = node.props.offset;
          const value = node.inputs[1];
          offsetState.set(offset, value);
          toDelete.add(node.id);
        } else if (
          node.type === ir.IR_LOAD_FIELD &&
          toDelete.has(node.inputs[0]?.id)
        ) {
          const offset = node.props.offset;
          let val = offsetState.get(offset);
          if (!val) {
            val = insertUndefinedConstant(block, i);
            blockOf.set(val, block);
            i++;
          }
          replaceValue(graph, node, val);
          replaceGraphFrameStateValue(graph, node, val);
          toDelete.add(node.id);
        } else if (
          node.type === ir.IR_GENERIC_SET_PROP &&
          toDelete.has(node.inputs[0]?.id)
        ) {
          const propName = node.props.propName;
          const value = node.inputs[1];
          propState.set(propName, value);
          toDelete.add(node.id);
        } else if (
          node.type === ir.IR_GENERIC_GET_PROP &&
          toDelete.has(node.inputs[0]?.id)
        ) {
          const propName = node.props.propName;
          let val = propState.get(propName);
          if (!val && propName === "length" && arrayLength !== null) {
            val = insertConstant(block, i, arrayLength);
            blockOf.set(val, block);
            i++;
          }
          if (!val) {
            val = insertUndefinedConstant(block, i);
            blockOf.set(val, block);
            i++;
          }
          replaceValue(graph, node, val);
          replaceGraphFrameStateValue(graph, node, val);
          toDelete.add(node.id);
        } else if (
          (node.type === ir.IR_STORE_ELEMENT ||
            node.type === ir.IR_GENERIC_SET_INDEX) &&
          toDelete.has(node.inputs[0]?.id)
        ) {
          const idx = elementKey(node);
          const value =
            node.type === ir.IR_STORE_ELEMENT ? node.inputs[2] : node.inputs[2];
          if (value) {
            offsetState.set("elem_" + idx, value);
            toDelete.add(node.id);
          }
        } else if (
          (node.type === ir.IR_LOAD_ELEMENT ||
            node.type === ir.IR_GENERIC_GET_INDEX) &&
          toDelete.has(node.inputs[0]?.id)
        ) {
          const idx = elementKey(node);
          let val = offsetState.get("elem_" + idx);
          if (!val) {
            val = insertUndefinedConstant(block, i);
            blockOf.set(val, block);
            i++;
          }
          replaceValue(graph, node, val);
          replaceGraphFrameStateValue(graph, node, val);
          toDelete.add(node.id);
        }
      }
    };

    const relevantBlocks = new Set<EscapeBlock>([allocBlock]);
    for (const use of safeUses) {
      const useBlock = blockOf.get(use);
      if (useBlock) relevantBlocks.add(useBlock);
    }

    const walkDom = (
      block: EscapeBlock,
      propState: ValueState,
      offsetState: ValueState,
    ): void => {
      const localProp = new Map(propState);
      const localOffset = new Map(offsetState);
      if (relevantBlocks.has(block)) {
        processBlock(block, localProp, localOffset);
      }
      for (const child of (children.get(block) || []) as EscapeBlock[]) {
        walkDom(child, localProp, localOffset);
      }
    };

    const initialOffset: ValueState = new Map();
    if (alloc.type === ir.IR_NEW_ARRAY) {
      for (let k = 0; k < alloc.inputs.length; k++) {
        if (alloc.inputs[k]) initialOffset.set("elem_i" + k, alloc.inputs[k]);
      }
    }

    walkDom(allocBlock, new Map(), initialOffset);

    removeNodes(graph, toDelete);

    tracer.jitCompile(
      graph.name,
      `EscapeAnalysis: Scalar replaced object allocation v${alloc.id} (${toDelete.size} nodes removed)`,
    );
    scalarReplCount++;
  }

  return scalarReplCount;
}

function elementKey(node: EscapeNode): string {
  if (node.props.index !== undefined) return "i" + String(node.props.index);
  const idxNode = node.inputs[1];
  if (idxNode && idxNode.type === ir.IR_CONSTANT) return "i" + String(idxNode.props.value);
  return idxNode ? "n" + idxNode.id : "i0";
}

function isPropertyUse(node: EscapeNode, aliases: Set<EscapeNode>): boolean {
  return (
    (node.type === ir.IR_GENERIC_SET_PROP || node.type === ir.IR_GENERIC_GET_PROP) &&
    aliases.has(node.inputs[0])
  );
}

function isElementUse(node: EscapeNode, aliases: Set<EscapeNode>): boolean {
  return (
    (node.type === ir.IR_GENERIC_SET_INDEX ||
      node.type === ir.IR_GENERIC_GET_INDEX ||
      node.type === ir.IR_STORE_ELEMENT ||
      node.type === ir.IR_LOAD_ELEMENT) &&
    aliases.has(node.inputs[0])
  );
}

function isFieldUse(node: EscapeNode, aliases: Set<EscapeNode>): boolean {
  return (
    (node.type === ir.IR_STORE_FIELD || node.type === ir.IR_LOAD_FIELD) &&
    aliases.has(node.inputs[0])
  );
}

function isReferenceGuard(node: EscapeNode, aliases: Set<EscapeNode>): boolean {
  return (
    (node.type === ir.IR_CHECK_MAP || node.type === ir.IR_CHECK_ARRAY) &&
    aliases.has(node.inputs[0])
  );
}

function isSameReferencePhi(node: EscapeNode, aliases: Set<EscapeNode>): boolean {
  return (
    node.type === ir.IR_PHI &&
    node.inputs.length > 0 &&
    node.inputs.every((input) => aliases.has(input))
  );
}

function insertUndefinedConstant(block: EscapeBlock, index: number): EscapeNode {
  const value = nodeFromIr(ir.irConstant(undefined));
  value.block = block;
  block.nodes.splice(index, 0, value);
  return value;
}

function insertConstant(
  block: EscapeBlock,
  index: number,
  constValue: RuntimeValue,
): EscapeNode {
  const value = nodeFromIr(ir.irConstant(constValue));
  value.block = block;
  block.nodes.splice(index, 0, value);
  return value;
}

function replaceValue(
  graph: EscapeGraph,
  oldValue: EscapeNode,
  newValue: EscapeNode,
): void {
  for (const use of [...oldValue.uses]) {
    for (let i = 0; i < use.inputs.length; i++) {
      if (use.inputs[i] === oldValue) {
        use.inputs[i] = newValue;
        newValue.uses.push(use);
      }
    }
  }
  oldValue.uses.length = 0;
}

function removeNodes(graph: EscapeGraph, toDelete: Set<number>): void {
  for (const block of graph.blocks) {
    const kept: EscapeNode[] = [];
    for (const node of block.nodes) {
      if (toDelete.has(node.id)) {
        detachInputs(node);
        node.uses = [];
        node.block = null;
      } else {
        kept.push(node);
      }
    }
    block.nodes = kept;
  }
}


import type { RuntimeValue } from "../../core/value/index.js";
import * as ir from "../ir/index.js";

import { tracer } from "../../core/tracing/index.js";
import { DominatorTree } from "../analyses/dominance.js";
import {
  replaceGraphFrameStateValue,
} from "../ir/frame-state-values.js";
import { detachInputs } from "../ir/graph-edit.js";
import type { PointsToResult } from "../analyses/points-to.js";
import type { FrameState, FrameValue } from "../../deopt/frame-state.js";
import { addPhi } from "../ir/cfg-edit.js";

type EscapeNode = ir.CFGInstruction;
type EscapeBlock = ir.CFGBlock;
type EscapeGraph = ir.CFGFunction;

type ValueState = Map<ir.IRMetadataValue, EscapeNode>;

const ALLOCATIONS = new Set([ir.IR_NEW_OBJECT, ir.IR_NEW_ARRAY]);
const IDENTITY_GUARDS = new Set([ir.IR_CHECK_MAP, ir.IR_CHECK_ARRAY]);
const RECEIVER_ACCESSES = new Set([
  ir.IR_GENERIC_SET_PROP,
  ir.IR_GENERIC_GET_PROP,
  ir.IR_GENERIC_SET_INDEX,
  ir.IR_GENERIC_GET_INDEX,
  ir.IR_STORE_ELEMENT,
  ir.IR_LOAD_ELEMENT,
  ir.IR_STORE_FIELD,
  ir.IR_LOAD_FIELD,
]);

function nodeFromIr(value: ir.CFGInstruction): EscapeNode {
  return value;
}

export function escapeAnalysisAndScalarReplacement(
  graph: EscapeGraph,
  dominance: DominatorTree,
  pointsTo: PointsToResult,
): number {
  let scalarReplCount = 0;

  const blockOf = new Map<EscapeNode, EscapeBlock>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      blockOf.set(node, block);
    }
  }

  const allocations: EscapeNode[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (ALLOCATIONS.has(node.type)) allocations.push(node);
    }
  }
  if (allocations.length === 0) return 0;

  const values = collectValues(graph);

  for (const alloc of allocations) {
    const allocBlock = blockOf.get(alloc);
    if (!allocBlock) continue;

    if (pointsTo.escapes(alloc)) continue;

    const aliases = new Set<EscapeNode>(
      values.filter((value) => pointsTo.allocClassOf(value) === alloc.id),
    );
    const safeUses = safeReceiverUses(aliases);
    if (callerFrameStatesReferenceAliases(graph, aliases)) continue;

    let allDominated = true;
    for (const use of safeUses) {
      const useBlock = blockOf.get(use);
      if (!useBlock) {
        allDominated = false;
        break;
      }
      if (!dominance.dominates(allocBlock, useBlock)) {
        allDominated = false;
        break;
      }
    }

    const initialOffset = initialOffsetState(alloc);
    if (requiresUnsupportedMergeState(safeUses, aliases, initialOffset)) continue;

    const toDelete = new Set<number>([...aliases].map((node) => node.id));
    const phiFieldStates = createPhiFieldStates(
      aliases,
      safeUses,
      initialOffset,
      blockOf,
    );

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

    const recordVirtualState = (
      node: EscapeNode,
      propState: ValueState,
      offsetState: ValueState,
    ): void => {
      const frameState = node.frameState;
      if (!frameState) return;
      for (let state: FrameState | null = frameState; state; state = state.callerFrameState) {
        if (!frameStateOwnValuesReferenceAliases(state, aliases)) continue;
        const sunk = state.sunkAllocations ?? new Map();
        sunk.set(alloc.id, {
          fields: new Map(offsetState) as Map<number, FrameValue>,
          props: new Map(propState) as Map<string, FrameValue>,
        });
        state.setSunkAllocations(sunk);
      }
    };

    const processBlock = (
      block: EscapeBlock,
      propState: ValueState,
      offsetState: ValueState,
    ): void => {
      const blockPhiState = phiFieldStates.get(block);
      if (blockPhiState) {
        for (const [key, value] of blockPhiState) offsetState.set(key, value);
      }
      for (let i = 0; i < block.nodes.length; i++) {
        const node = block.nodes[i];
        recordVirtualState(node, propState, offsetState);
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
          if (typeof node.props.propName === "string") {
            propState.set(node.props.propName, value);
          }
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

    const walkDom = (
      block: EscapeBlock,
      propState: ValueState,
      offsetState: ValueState,
    ): void => {
      const localProp = new Map(propState);
      const localOffset = new Map(offsetState);
      processBlock(block, localProp, localOffset);
      for (const child of dominance.childrenOf(block) as readonly EscapeBlock[]) {
        walkDom(child, localProp, localOffset);
      }
    };

    walkDom(allocBlock, new Map(), initialOffset);

    for (const alias of aliases) {
      if (alias !== alloc) replaceGraphFrameStateValue(graph, alias, alloc);
    }

    removeNodes(graph, toDelete);

    tracer.jitCompile(
      graph.name,
      `EscapeAnalysis: Scalar replaced object allocation v${alloc.id} (${toDelete.size} nodes removed)`,
    );
    scalarReplCount++;
  }

  return scalarReplCount;
}

function callerFrameStatesReferenceAliases(
  graph: EscapeGraph,
  aliases: ReadonlySet<EscapeNode>,
): boolean {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const seen = new Set<FrameState>();
      let isCaller = false;
      for (let state: FrameState | null = node.frameState; state; state = state.callerFrameState) {
        if (seen.has(state)) break;
        seen.add(state);
        if (isCaller && frameStateOwnValuesReferenceAliases(state, aliases)) return true;
        isCaller = true;
      }
    }
  }
  return false;
}

function frameStateOwnValuesReferenceAliases(
  frameState: FrameState,
  aliases: ReadonlySet<EscapeNode>,
): boolean {
  const isAlias = (value: FrameValue | null | undefined): boolean =>
    !!value && aliases.has(value as EscapeNode);
  for (const value of frameState.localValues.values()) {
    if (isAlias(value)) return true;
  }
  for (const value of frameState.stackValues) {
    if (isAlias(value)) return true;
  }
  return isAlias(frameState.thisValue);
}

function collectValues(graph: EscapeGraph): EscapeNode[] {
  const values: EscapeNode[] = [...graph.parameters];
  for (const block of graph.blocks) values.push(...block.nodes);
  return values;
}

function safeReceiverUses(aliases: ReadonlySet<EscapeNode>): Set<EscapeNode> {
  const uses = new Set<EscapeNode>();
  for (const alias of aliases) {
    for (const use of alias.uses) {
      if (IDENTITY_GUARDS.has(use.type) && use.inputs[0] === alias) {
        uses.add(use);
        continue;
      }
      if (RECEIVER_ACCESSES.has(use.type) && use.inputs[0] === alias) {
        uses.add(use);
      }
    }
  }
  return uses;
}

function requiresUnsupportedMergeState(
  safeUses: ReadonlySet<EscapeNode>,
  aliases: ReadonlySet<EscapeNode>,
  initialOffset: ValueState,
): boolean {
  for (const use of safeUses) {
    const block = use.block;
    if (!block || block.predecessors.length < 2) continue;
    const base = use.inputs[0];
    if (base?.type !== ir.IR_PHI || !aliases.has(base) || base.block !== block) {
      return true;
    }
    if (
      use.type === ir.IR_GENERIC_GET_PROP ||
      use.type === ir.IR_GENERIC_SET_PROP
    ) {
      return true;
    }
    const key = offsetStateKey(use);
    if (key === null) return true;
    for (let index = 0; index < block.predecessors.length; index++) {
      const predecessor = block.predecessors[index]!;
      if (latestStoreForField(predecessor, key, aliases)) continue;
      const objectInput = base.inputs[index];
      if (objectInput === base) continue;
      if (initialOffset.has(key)) continue;
      return true;
    }
  }
  return false;
}

function initialOffsetState(alloc: EscapeNode): ValueState {
  const state: ValueState = new Map();
  if (alloc.type === ir.IR_NEW_ARRAY) {
    for (let index = 0; index < alloc.inputs.length; index++) {
      if (alloc.inputs[index]) state.set("elem_i" + index, alloc.inputs[index]);
    }
  }
  return state;
}

function createPhiFieldStates(
  aliases: ReadonlySet<EscapeNode>,
  safeUses: ReadonlySet<EscapeNode>,
  initialOffset: ValueState,
  blockOf: Map<EscapeNode, EscapeBlock>,
): Map<EscapeBlock, ValueState> {
  const out = new Map<EscapeBlock, ValueState>();
  for (const alias of aliases) {
    if (alias.type !== ir.IR_PHI || !alias.block || !alias.block.phis.includes(alias)) continue;
    const fieldKeys = fieldKeysForAlias(alias, safeUses);
    if (fieldKeys.size === 0) continue;
    let blockState = out.get(alias.block);
    if (!blockState) {
      blockState = new Map();
      out.set(alias.block, blockState);
    }
    for (const key of fieldKeys) {
      const phi = addPhi(alias.block, []);
      blockOf.set(phi, alias.block);
      blockState.set(key, phi);
      for (let index = 0; index < alias.block.predecessors.length; index++) {
        const predecessor = alias.block.predecessors[index]!;
        const stored = latestStoreForField(predecessor, key, aliases);
        if (stored) {
          phi.addInput(stored);
          continue;
        }
        const objectInput = alias.inputs[index];
        if (objectInput === alias) {
          phi.addInput(phi);
          continue;
        }
        if (initialOffset.has(key)) {
          phi.addInput(initialOffset.get(key)!);
        }
      }
    }
  }
  return out;
}

function fieldKeysForAlias(
  alias: EscapeNode,
  safeUses: ReadonlySet<EscapeNode>,
): Set<ir.IRMetadataValue> {
  const keys = new Set<ir.IRMetadataValue>();
  for (const use of safeUses) {
    if (use.inputs[0] !== alias) continue;
    const key = offsetStateKey(use);
    if (key !== null) keys.add(key);
  }
  return keys;
}

function latestStoreForField(
  block: EscapeBlock,
  key: ir.IRMetadataValue,
  aliases: ReadonlySet<EscapeNode>,
): EscapeNode | null {
  for (let index = block.nodes.length - 1; index >= 0; index--) {
    const node = block.nodes[index]!;
    if (!aliases.has(node.inputs[0])) continue;
    if (offsetStateKey(node) !== key) continue;
    return storedValue(node);
  }
  return null;
}

function offsetStateKey(node: EscapeNode): ir.IRMetadataValue | null {
  if (
    node.type === ir.IR_STORE_FIELD ||
    node.type === ir.IR_LOAD_FIELD
  ) {
    return node.props.offset ?? null;
  }
  if (
    node.type === ir.IR_STORE_ELEMENT ||
    node.type === ir.IR_LOAD_ELEMENT ||
    node.type === ir.IR_GENERIC_SET_INDEX ||
    node.type === ir.IR_GENERIC_GET_INDEX
  ) {
    return "elem_" + elementKey(node);
  }
  return null;
}

function storedValue(node: EscapeNode): EscapeNode | null {
  if (node.type === ir.IR_STORE_FIELD) return node.inputs[1] ?? null;
  if (node.type === ir.IR_STORE_ELEMENT || node.type === ir.IR_GENERIC_SET_INDEX) {
    return node.inputs[2] ?? null;
  }
  return null;
}

function elementKey(node: EscapeNode): string {
  if (node.props.index !== undefined) return "i" + String(node.props.index);
  const idxNode = node.inputs[1];
  if (idxNode && idxNode.type === ir.IR_CONSTANT) return "i" + String(idxNode.props.value);
  return idxNode ? "n" + idxNode.id : "i0";
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
    block.phis = block.phis.filter((node) => !toDelete.has(node.id));
    for (let index = 0; index < block.phis.length; index++) block.phis[index].props.index = index;
    block.nodes = kept;
  }
}


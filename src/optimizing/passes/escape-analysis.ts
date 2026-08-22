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
import { addPhi, removePhi } from "../ir/cfg-edit.js";

type EscapeNode = ir.CFGInstruction;
type EscapeBlock = ir.CFGBlock;
type EscapeGraph = ir.CFGFunction;

type ValueState = Map<ir.IRMetadataValue, EscapeNode>;

const ALLOCATIONS = new Set([ir.IR_NEW_OBJECT, ir.IR_NEW_ARRAY]);
const IDENTITY_GUARDS = new Set([ir.IR_CHECK_MAP, ir.IR_CHECK_ARRAY]);
const ELEMENT_ACCESSES = new Set([
  ir.IR_LOAD_ELEMENT,
  ir.IR_STORE_ELEMENT,
  ir.IR_GENERIC_GET_INDEX,
  ir.IR_GENERIC_SET_INDEX,
]);
const AGGREGATE_STORES = new Set([
  ir.IR_STORE_FIELD,
  ir.IR_STORE_ELEMENT,
  ir.IR_GENERIC_SET_PROP,
  ir.IR_GENERIC_SET_INDEX,
]);
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
    if (hasUnsupportedAliasUses(aliases, safeUses)) continue;
    if (hasUnresolvedElementIndex(safeUses)) continue;
    if (hasUntrackedLoopStore(graph, safeUses, aliases, dominance)) continue;
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
    if (!allDominated) continue;

    const initialOffset = initialOffsetState(alloc);
    if (requiresUnsupportedMergeState(graph, safeUses, aliases, initialOffset, dominance)) continue;

    const phiFieldStates = createPhiFieldStates(
      graph,
      aliases,
      safeUses,
      initialOffset,
      blockOf,
      dominance,
    );
    if (phiFieldStates === null) continue;

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

function hasUnsupportedAliasUses(
  aliases: ReadonlySet<EscapeNode>,
  safeUses: ReadonlySet<EscapeNode>,
): boolean {
  for (const alias of aliases) {
    for (const use of alias.uses) {
      if (safeUses.has(use)) continue;
      if (aliases.has(use) && use.type === ir.IR_PHI) continue;
      return true;
    }
  }
  return false;
}

function requiresUnsupportedMergeState(
  graph: EscapeGraph,
  safeUses: ReadonlySet<EscapeNode>,
  aliases: ReadonlySet<EscapeNode>,
  initialOffset: ValueState,
  dominance: DominatorTree,
): boolean {
  for (const use of safeUses) {
    if (IDENTITY_GUARDS.has(use.type)) continue;
    const block = use.block;
    if (!block || block.predecessors.length < 2) continue;
    const base = receiverRoot(use.inputs[0]);
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
      const objectInput: EscapeNode | undefined = base.inputs[index];
      if (objectInput === base) continue;
      if (initialOffset.has(key)) continue;
      return true;
    }
  }
  for (const header of graph.blocks) {
    if (!isLoopHeader(header, dominance)) continue;
    const keys = new Set<ir.IRMetadataValue>();
    for (const use of safeUses) {
      if (IDENTITY_GUARDS.has(use.type)) continue;
      const block = use.block;
      if (!block || !dominance.dominates(header, block)) continue;
      if (
        use.type === ir.IR_GENERIC_GET_PROP ||
        use.type === ir.IR_GENERIC_SET_PROP
      ) {
        return true;
      }
      const key = offsetStateKey(use);
      if (key === null) continue;
      if (hasBackedgeStore(header, key, aliases, dominance)) keys.add(key);
    }
    for (const key of keys) {
      for (const predecessor of header.predecessors) {
        if (latestStoreForField(predecessor, key, aliases)) continue;
        if (dominance.dominates(header, predecessor)) continue;
        if (initialOffset.has(key)) continue;
        return true;
      }
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
  graph: EscapeGraph,
  aliases: ReadonlySet<EscapeNode>,
  safeUses: ReadonlySet<EscapeNode>,
  initialOffset: ValueState,
  blockOf: Map<EscapeNode, EscapeBlock>,
  dominance: DominatorTree,
): Map<EscapeBlock, ValueState> | null {
  const out = new Map<EscapeBlock, ValueState>();
  const created: Array<readonly [EscapeBlock, EscapeNode]> = [];
  let incomplete = false;
  const ensureBlockState = (block: EscapeBlock): ValueState => {
    let blockState = out.get(block);
    if (!blockState) {
      blockState = new Map();
      out.set(block, blockState);
    }
    return blockState;
  };
  const createFieldPhi = (
    block: EscapeBlock,
    key: ir.IRMetadataValue,
    inputForPredecessor: (
      predecessor: EscapeBlock,
      index: number,
      phi: EscapeNode,
    ) => EscapeNode | null,
  ): void => {
    const blockState = ensureBlockState(block);
    if (blockState.has(key)) return;
    const phi = addPhi(block, []);
    const inputs: EscapeNode[] = [];
    for (let index = 0; index < block.predecessors.length; index++) {
      const predecessor = block.predecessors[index]!;
      const input = inputForPredecessor(predecessor, index, phi);
      if (!input) break;
      const definition = input === phi ? null : blockOf.get(input);
      if (definition && !dominance.dominates(definition, predecessor)) break;
      inputs.push(input);
    }
    if (inputs.length !== block.predecessors.length) {
      removePhi(block, phi);
      incomplete = true;
      return;
    }
    for (const input of inputs) phi.addInput(input);
    blockOf.set(phi, block);
    blockState.set(key, phi);
    created.push([block, phi]);
  };

  for (const alias of aliases) {
    if (alias.type !== ir.IR_PHI || !alias.block || !alias.block.phis.includes(alias)) continue;
    const fieldKeys = fieldKeysForAlias(alias, safeUses);
    if (fieldKeys.size === 0) continue;
    for (const key of fieldKeys) {
      createFieldPhi(alias.block, key, (predecessor, index, phi) => {
        const stored = latestStoreForField(predecessor, key, aliases);
        if (stored) return stored;
        const objectInput = alias.inputs[index];
        if (objectInput === alias) return phi;
        return initialOffset.get(key) ?? null;
      });
    }
  }
  for (const header of graph.blocks) {
    if (!isLoopHeader(header, dominance)) continue;
    const fieldKeys = fieldKeysForLoopHeader(header, safeUses, aliases, dominance);
    for (const key of fieldKeys) {
      createFieldPhi(header, key, (predecessor, _index, phi) => {
        const stored = latestStoreForField(predecessor, key, aliases);
        if (stored) return stored;
        if (dominance.dominates(header, predecessor)) return phi;
        return initialOffset.get(key) ?? null;
      });
    }
  }
  if (incomplete) {
    for (const [block, phi] of created) {
      removePhi(block, phi);
      blockOf.delete(phi);
    }
    return null;
  }
  return out;
}

function isLoopHeader(block: EscapeBlock, dominance: DominatorTree): boolean {
  return block.predecessors.some((predecessor) =>
    dominance.dominates(block, predecessor),
  );
}

function naturalLoopBody(
  header: EscapeBlock,
  dominance: DominatorTree,
): Set<EscapeBlock> {
  const body = new Set<EscapeBlock>([header]);
  const stack: EscapeBlock[] = [];
  for (const latch of header.predecessors) {
    if (!dominance.dominates(header, latch) || body.has(latch)) continue;
    body.add(latch);
    stack.push(latch);
  }
  while (stack.length > 0) {
    const block = stack.pop()!;
    for (const predecessor of block.predecessors) {
      if (body.has(predecessor)) continue;
      body.add(predecessor);
      stack.push(predecessor);
    }
  }
  return body;
}

function hasUntrackedLoopStore(
  graph: EscapeGraph,
  safeUses: ReadonlySet<EscapeNode>,
  aliases: ReadonlySet<EscapeNode>,
  dominance: DominatorTree,
): boolean {
  for (const header of graph.blocks) {
    if (!isLoopHeader(header, dominance)) continue;
    const body = naturalLoopBody(header, dominance);
    for (const use of safeUses) {
      if (!AGGREGATE_STORES.has(use.type)) continue;
      if (!use.block || !body.has(use.block)) continue;
      const receiver = receiverRoot(use.inputs[0]);
      if (!receiver || !aliases.has(receiver)) continue;
      const key = offsetStateKey(use);
      if (key === null) return true;
      if (!hasBackedgeStore(header, key, aliases, dominance)) return true;
    }
  }
  return false;
}

function fieldKeysForLoopHeader(
  header: EscapeBlock,
  safeUses: ReadonlySet<EscapeNode>,
  aliases: ReadonlySet<EscapeNode>,
  dominance: DominatorTree,
): Set<ir.IRMetadataValue> {
  const keys = new Set<ir.IRMetadataValue>();
  for (const use of safeUses) {
    if (IDENTITY_GUARDS.has(use.type)) continue;
    const block = use.block;
    if (!block || !dominance.dominates(header, block)) continue;
    const receiver = receiverRoot(use.inputs[0]);
    if (!receiver || !aliases.has(receiver)) continue;
    const key = offsetStateKey(use);
    if (key !== null && hasBackedgeStore(header, key, aliases, dominance)) {
      keys.add(key);
    }
  }
  return keys;
}

function hasBackedgeStore(
  header: EscapeBlock,
  key: ir.IRMetadataValue,
  aliases: ReadonlySet<EscapeNode>,
  dominance: DominatorTree,
): boolean {
  for (const predecessor of header.predecessors) {
    if (!dominance.dominates(header, predecessor)) continue;
    if (latestStoreForField(predecessor, key, aliases)) return true;
  }
  return false;
}

function fieldKeysForAlias(
  alias: EscapeNode,
  safeUses: ReadonlySet<EscapeNode>,
): Set<ir.IRMetadataValue> {
  const keys = new Set<ir.IRMetadataValue>();
  for (const use of safeUses) {
    if (receiverRoot(use.inputs[0]) !== alias) continue;
    const key = offsetStateKey(use);
    if (key !== null) keys.add(key);
  }
  return keys;
}

function receiverRoot(value: EscapeNode | null | undefined): EscapeNode | null {
  let current = value ?? null;
  const seen = new Set<EscapeNode>();
  while (
    current &&
    IDENTITY_GUARDS.has(current.type) &&
    current.inputs[0] &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = current.inputs[0];
  }
  return current;
}

function latestStoreForField(
  block: EscapeBlock,
  key: ir.IRMetadataValue,
  aliases: ReadonlySet<EscapeNode>,
): EscapeNode | null {
  for (let index = block.nodes.length - 1; index >= 0; index--) {
    const node = block.nodes[index]!;
    const receiver = receiverRoot(node.inputs[0]);
    if (!receiver || !aliases.has(receiver)) continue;
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

function slotOf(node: EscapeNode): number | null {
  const value = node.inputs[1]?.props.value;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value >= 0) return value;
  const root = receiverRoot(node.inputs[0]);
  if (!root || root.type !== ir.IR_NEW_ARRAY) return null;
  const counted = root.inputs.length + value;
  return counted >= 0 ? counted : null;
}

function elementKey(node: EscapeNode): string {
  if (node.props.index !== undefined) return "i" + String(node.props.index);
  return "i" + String(slotOf(node));
}

function slotBeyondTheArray(node: EscapeNode, slot: number): boolean {
  const root = receiverRoot(node.inputs[0]);
  if (!root || root.type !== ir.IR_NEW_ARRAY) return false;
  return slot >= root.inputs.length;
}

function hasUnresolvedElementIndex(safeUses: ReadonlySet<EscapeNode>): boolean {
  for (const use of safeUses) {
    if (!ELEMENT_ACCESSES.has(use.type)) continue;
    if (use.props.index !== undefined) continue;
    const index = use.inputs[1];
    if (!index || index.type !== ir.IR_CONSTANT) return true;
    const slot = slotOf(use);
    if (slot === null) return true;
    if (slotBeyondTheArray(use, slot)) return true;
  }
  return false;
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


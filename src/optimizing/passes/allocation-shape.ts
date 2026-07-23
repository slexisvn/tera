import * as ir from "../ir/index.js";
import { getHiddenClassById } from "../../objects/maps/hidden-class.js";
import { metadataNumber } from "../ir/metadata.js";
import { detachNode, replaceValueUses } from "./graph-edit.js";
import { findLoops } from "./loop-opts.js";

type ShapeNode = ir.CFGInstruction;
type ShapeGraph = ir.CFGFunction;

type InitializerChain = {
  checks: ShapeNode[];
  mapId: number;
  slotCount: number;
};

export function specializeAllocationShapes(graph: ShapeGraph): number {
  let specialized = 0;

  const repeatedBlocks = new Set<number>();
  for (const loop of findLoops(graph)) {
    for (const block of loop.blocks) repeatedBlocks.add(block.id);
  }

  for (const block of graph.blocks) {
    if (repeatedBlocks.has(block.id)) continue;

    const position = new Map<ShapeNode, number>();
    for (let index = 0; index < block.nodes.length; index++) {
      position.set(block.nodes[index], index);
    }

    const initializerChain = (alloc: ShapeNode): InitializerChain | null => {
      const checks: ShapeNode[] = [];
      const offsets = new Set<number>();
      let lastInitPosition = -1;
      let firstOtherPosition = Number.POSITIVE_INFINITY;
      let finalCheck: ShapeNode | null = null;

      for (const use of alloc.uses) {
        const checkPosition = position.get(use);
        if (
          use.type !== ir.IR_CHECK_MAP ||
          use.inputs[0] !== alloc ||
          checkPosition === undefined
        ) {
          if (checkPosition !== undefined && checkPosition < firstOtherPosition)
            firstOtherPosition = checkPosition;
          continue;
        }
        if (use.uses.length === 0) return null;
        for (const store of use.uses) {
          const storePosition = position.get(store);
          if (
            store.type !== ir.IR_STORE_FIELD ||
            store.inputs[0] !== use ||
            storePosition === undefined
          )
            return null;
          const offset = metadataNumber(store.props.offset);
          if (offset === null) return null;
          offsets.add(offset);
          if (storePosition > lastInitPosition) lastInitPosition = storePosition;
        }
        checks.push(use);
        if (checkPosition > lastInitPosition) lastInitPosition = checkPosition;
        if (finalCheck === null || checkPosition > position.get(finalCheck)!)
          finalCheck = use;
      }

      if (finalCheck === null) return null;
      if (firstOtherPosition < lastInitPosition) return null;

      const mapId = metadataNumber(finalCheck.props.expectedMapId);
      if (mapId === null) return null;
      const hiddenClass = getHiddenClassById(mapId);
      if (!hiddenClass) return null;

      const slotCount = hiddenClass.propertyCount;
      if (offsets.size !== slotCount) return null;
      for (let slot = 0; slot < slotCount; slot++) {
        if (!offsets.has(slot)) return null;
      }

      return { checks, mapId, slotCount };
    };

    const removed = new Set<ShapeNode>();
    for (const alloc of block.nodes) {
      if (alloc.type !== ir.IR_NEW_OBJECT) continue;
      if (alloc.props.targetHiddenClassId != null) continue;

      const chain = initializerChain(alloc);
      if (!chain) continue;

      for (const check of chain.checks) {
        replaceValueUses(graph, check, alloc);
        detachNode(check);
        removed.add(check);
      }
      alloc.props.targetHiddenClassId = chain.mapId;
      alloc.props.targetSlotCount = chain.slotCount;
      specialized++;
    }

    if (removed.size > 0) {
      block.nodes = block.nodes.filter((node) => !removed.has(node));
    }
  }

  if (specialized > 0) graph.rebuildUses();
  return specialized;
}

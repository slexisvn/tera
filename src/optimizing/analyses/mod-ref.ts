import * as ir from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import { fieldOf, locationKey, type Field, type Partition } from "./heap-model.js";
import { pointsToAnalysisId } from "./points-to.js";

export interface ModRef {
  gref(node: ir.CFGInstruction): ReadonlySet<string>;
  gmod(node: ir.CFGInstruction): ReadonlySet<string>;
  killsEverything(node: ir.CFGInstruction): boolean;
}

type Location = {
  readonly partition: Partition;
  readonly field: Field;
};

const EMPTY = new Set<string>();
const FIELD_LOADS = new Set([ir.IR_LOAD_FIELD, ir.IR_LOAD_ELEMENT]);
const FIELD_STORES = new Set([ir.IR_STORE_FIELD, ir.IR_STORE_ELEMENT]);
const CALLS = new Set([
  ir.IR_GENERIC_CALL,
  ir.IR_MAKE_CLOSURE,
  ir.IR_STORE_CONTEXT_SLOT,
  ir.IR_CALL_BUILTIN,
  ir.IR_CALL_INTRINSIC,
  ir.IR_CALL_KNOWN_FUNCTION,
]);
const GENERIC_ACCESSES = new Set([
  ir.IR_GENERIC_GET_PROP,
  ir.IR_GENERIC_SET_PROP,
  ir.IR_GENERIC_DELETE_PROP,
  ir.IR_GENERIC_GET_INDEX,
  ir.IR_GENERIC_SET_INDEX,
  ir.IR_POLYMORPHIC_LOAD,
  ir.IR_POLYMORPHIC_STORE,
  ir.IR_MEGAMORPHIC_LOAD,
  ir.IR_MEGAMORPHIC_STORE,
]);

export const modRefAnalysisId = analysisId<ModRef>("mod-ref");

export const modRefAnalysis: AnalysisPass<ir.CFGFunction, ModRef> = {
  id: modRefAnalysisId,
  run(graph, analyses) {
    const pointsTo = analyses.get(pointsToAnalysisId);
    const refs = new Map<ir.CFGInstruction, ReadonlySet<string>>();
    const mods = new Map<ir.CFGInstruction, ReadonlySet<string>>();
    const kills = new Set<ir.CFGInstruction>();

    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (FIELD_LOADS.has(node.type)) {
          refs.set(node, singletonLocation(fieldLocation(node)));
          continue;
        }
        if (FIELD_STORES.has(node.type)) {
          mods.set(node, singletonLocation(fieldLocation(node)));
          continue;
        }
        if (node.type === ir.IR_LOAD_GLOBAL) {
          refs.set(node, singletonLocation(globalLocation(node)));
          continue;
        }
        if (node.type === ir.IR_STORE_GLOBAL) {
          mods.set(node, singletonLocation(globalLocation(node)));
          continue;
        }
        if (node.type === ir.IR_CALL_INTRINSIC) {
          const reads = stringSet(node.props.intrinsicReads);
          const writes = stringSet(node.props.intrinsicWrites);
          if (reads.size > 0) refs.set(node, reads);
          if (writes.size > 0) mods.set(node, writes);
          if (node.effectKind === ir.EFFECT_CALL && node.props.pure !== true) kills.add(node);
          if (node.effectKind === ir.EFFECT_WRITE && writes.size === 0) kills.add(node);
          continue;
        }
        if (CALLS.has(node.type) && node.props.pure !== true) {
          kills.add(node);
          continue;
        }
        if (GENERIC_ACCESSES.has(node.type) && node.props.pure !== true) {
          kills.add(node);
        }
      }
    }

    function fieldLocation(node: ir.CFGInstruction): Location | null {
      const base = node.inputs[0];
      const field = fieldOf(node);
      if (!base || !field) return null;
      return { partition: pointsTo.partitionOf(base), field };
    }

    return {
      gref: (node) => refs.get(node) ?? EMPTY,
      gmod: (node) => mods.get(node) ?? EMPTY,
      killsEverything: (node) => kills.has(node),
    };
  },
};

function singletonLocation(location: Location | null): ReadonlySet<string> {
  return location ? new Set([locationKey(location.partition, location.field)]) : EMPTY;
}

function globalLocation(node: ir.CFGInstruction): Location | null {
  return typeof node.props.name === "string"
    ? {
        partition: { kind: "global", name: node.props.name },
        field: { kind: "anyIndex" },
      }
    : null;
}

function stringSet(value: ir.IRMetadataValue | undefined): ReadonlySet<string> {
  if (!Array.isArray(value)) return EMPTY;
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.add(item);
  }
  return out;
}

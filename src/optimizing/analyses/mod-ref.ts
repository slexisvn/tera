import * as ir from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import {
  basesMayAlias,
  locationsMayAlias,
  memoryLocationOf,
  type MemoryLocation,
} from "./heap-model.js";
import { pointsToAnalysisId, type PointsToResult } from "./points-to.js";

export interface RegionMemory {
  readonly clobbersEverything: boolean;
  readonly locations: readonly MemoryLocation[];
  readonly keys: ReadonlySet<string>;
}

export interface ModRef {
  locationOf(node: ir.CFGInstruction): MemoryLocation | null;
  gref(node: ir.CFGInstruction): ReadonlySet<string>;
  gmod(node: ir.CFGInstruction): ReadonlySet<string>;
  killsEverything(node: ir.CFGInstruction): boolean;
  mayAlias(left: MemoryLocation, right: MemoryLocation): boolean;
  basesMayAlias(
    left: Pick<MemoryLocation, "base" | "baseKey">,
    right: Pick<MemoryLocation, "base" | "baseKey">,
  ): boolean;
  writesOf(blocks: Iterable<ir.CFGBlock>): RegionMemory;
  mayReadFrom(node: ir.CFGInstruction, region: RegionMemory): boolean;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

export const EMPTY_REGION: RegionMemory = {
  clobbersEverything: false,
  locations: [],
  keys: EMPTY,
};

export const modRefAnalysisId = analysisId<ModRef>("mod-ref");

export const modRefAnalysis: AnalysisPass<ir.CFGFunction, ModRef> = {
  id: modRefAnalysisId,
  run(graph, analyses) {
    return buildModRef(graph, analyses.get(pointsToAnalysisId));
  },
};

function locatesMemory(opcode: string): boolean {
  const access = ir.memoryAccessOf(opcode);
  return access === ir.ACCESS_SLOT || access === ir.ACCESS_ELEMENT || access === ir.ACCESS_GLOBAL;
}

export function buildModRef(graph: ir.CFGFunction, pointsTo: PointsToResult): ModRef {
  const locations = new Map<ir.CFGInstruction, MemoryLocation | null>();
  const refs = new Map<ir.CFGInstruction, ReadonlySet<string>>();
  const mods = new Map<ir.CFGInstruction, ReadonlySet<string>>();
  const writeLocations = new Map<ir.CFGInstruction, MemoryLocation>();
  const kills = new Set<ir.CFGInstruction>();

  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const effects = ir.effectsOf(node);
      const location = locatesMemory(node.type) ? memoryLocationOf(node, pointsTo) : null;
      locations.set(node, location);

      if (location !== null) {
        const keys = new Set([location.key]);
        if (effects.writes !== ir.MEMORY_NONE) {
          mods.set(node, keys);
          writeLocations.set(node, location);
        } else if (ir.readsMutableMemory(node)) {
          refs.set(node, keys);
        }
        continue;
      }

      const declaredReads = domainSet(node.props.intrinsicReads);
      const declaredWrites = domainSet(node.props.intrinsicWrites);
      if (declaredReads.size > 0) refs.set(node, declaredReads);
      if (declaredWrites.size > 0) mods.set(node, declaredWrites);

      if (ir.clobbersAllMemory(node) || ir.hasOpaqueMemoryEffect(node.type)) {
        kills.add(node);
        continue;
      }
      if (effects.writes !== ir.MEMORY_NONE && declaredWrites.size === 0) kills.add(node);
    }
  }

  const mayAlias = (left: MemoryLocation, right: MemoryLocation): boolean =>
    locationsMayAlias(left, right, pointsTo);

  const locationFor = (node: ir.CFGInstruction): MemoryLocation | null => {
    const known = locations.get(node);
    return known === undefined ? memoryLocationOf(node, pointsTo) : known;
  };

  return {
    locationOf: (node) => memoryLocationOf(node, pointsTo),
    gref: (node) => refs.get(node) ?? EMPTY,
    gmod: (node) => mods.get(node) ?? EMPTY,
    killsEverything: (node) => kills.has(node),
    mayAlias,
    basesMayAlias: (left, right) => basesMayAlias(left, right, pointsTo),

    writesOf(blocks) {
      const regionLocations: MemoryLocation[] = [];
      const keys = new Set<string>();
      let clobbersEverything = false;
      for (const block of blocks) {
        for (const node of block.nodes) {
          if (kills.has(node)) {
            clobbersEverything = true;
            continue;
          }
          const written = writeLocations.get(node);
          if (written !== undefined) regionLocations.push(written);
          else if (ir.writesMemory(node)) clobbersEverything = true;
          for (const key of mods.get(node) ?? EMPTY) keys.add(key);
        }
      }
      return { clobbersEverything, locations: regionLocations, keys };
    },

    mayReadFrom(node, region) {
      if (!ir.readsMutableMemory(node)) return false;
      if (region.clobbersEverything) return true;
      if (region.locations.length === 0 && region.keys.size === 0) return false;
      for (const domain of refs.get(node) ?? EMPTY) {
        if (region.keys.has(domain)) return true;
      }
      const location = locationFor(node);
      if (location === null) return true;
      if (region.keys.has(location.key)) return true;
      return region.locations.some((written) => mayAlias(written, location));
    },
  };
}

function domainSet(value: ir.IRMetadataValue | undefined): ReadonlySet<string> {
  if (!Array.isArray(value)) return EMPTY;
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.add(item);
  }
  return out;
}

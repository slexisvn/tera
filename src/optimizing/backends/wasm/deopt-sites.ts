import type { CFGFunction, CFGInstruction } from "../../ir/index.js";
import { canDeoptimize } from "../../ir/operations.js";
import { deoptReasonForNode } from "./deopt-reasons.js";
import type { DeoptSiteLike, DeoptSiteLookup } from "../../../deopt/origin.js";

export type DeoptSite = DeoptSiteLike;

const NONE: readonly DeoptSite[] = [];

export function siteOf(node: CFGInstruction): DeoptSite {
  return {
    nodeId: node.id,
    opcode: node.type,
    reason: deoptReasonForNode(node),
    blockId: node.block === null ? -1 : node.block.id,
    frameStateId: node.frameState === null ? -1 : node.frameState.id,
    bytecodeOffset: node.frameState === null ? -1 : node.frameState.bytecodeOffset,
    line: node.position === null ? null : node.position.line,
  };
}

export class DeoptSiteTable implements DeoptSiteLookup {
  readonly sites: readonly DeoptSite[];
  private readonly byFrameState = new Map<number, DeoptSite[]>();

  constructor(sites: readonly DeoptSite[]) {
    this.sites = sites;
    for (const site of sites) {
      const bucket = this.byFrameState.get(site.frameStateId);
      if (bucket === undefined) this.byFrameState.set(site.frameStateId, [site]);
      else bucket.push(site);
    }
  }

  resolve(reason: string, frameStateId: number): readonly DeoptSite[] {
    const sharing = this.byFrameState.get(frameStateId);
    if (sharing !== undefined) {
      const exact = sharing.filter((site) => site.reason === reason);
      return exact.length > 0 ? exact : sharing;
    }
    const anywhere = this.sites.filter((site) => site.reason === reason);
    return anywhere.length > 0 ? anywhere : NONE;
  }
}

export function collectDeoptSites(graph: CFGFunction): DeoptSiteTable {
  const sites: DeoptSite[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (canDeoptimize(node)) sites.push(siteOf(node));
    }
  }
  return new DeoptSiteTable(sites);
}

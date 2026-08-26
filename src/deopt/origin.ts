import type { TraceData } from "../core/tracing/index.js";

export interface DeoptSiteLike {
  readonly nodeId: number;
  readonly opcode: string;
  readonly reason: string;
  readonly blockId: number;
  readonly frameStateId: number;
  readonly bytecodeOffset: number;
  readonly line: number | null;
}

export interface DeoptSiteLookup {
  resolve(reason: string, frameStateId: number): readonly DeoptSiteLike[];
}

export interface DeoptOriginInput {
  readonly name: string;
  readonly reason: string;
  readonly bytecodeOffset: number;
  readonly frameStateId: number;
  readonly guard?: DeoptSiteLike | null;
  readonly sites?: DeoptSiteLookup | null;
}

const NONE: readonly DeoptSiteLike[] = [];

function candidatesFor(input: DeoptOriginInput): readonly DeoptSiteLike[] {
  if (input.guard !== undefined && input.guard !== null) return [input.guard];
  return input.sites?.resolve(input.reason, input.frameStateId) ?? NONE;
}

export function deoptOriginData(input: DeoptOriginInput): TraceData {
  const candidates = candidatesFor(input);
  const guard = candidates.length === 1 ? candidates[0]! : null;
  return {
    function: input.name,
    reason: input.reason,
    bytecodeOffset: input.bytecodeOffset,
    frameStateId: input.frameStateId,
    nodeId: guard === null ? null : guard.nodeId,
    opcode: guard === null ? null : guard.opcode,
    blockId: guard === null ? null : guard.blockId,
    line: guard === null ? null : guard.line,
    candidates: candidates.map((site) => site.nodeId),
  };
}

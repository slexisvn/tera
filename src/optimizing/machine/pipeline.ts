import type { CFGFunction } from "../ir/index.js";
import type { AnalysisManager } from "../infra/analysis-manager.js";
import { dominanceAnalysisId } from "../analyses/dominance.js";
import type { AotLegality } from "../analyses/aot-legality.js";
import { layoutFrame, type FrameLayout } from "./frame.js";
import { insertFrameCode } from "./frame-code.js";
import type { MachineFunction } from "./ir.js";
import { allocateRegisters, type Allocation } from "./linear-scan.js";
import { assignPositions, computeLiveness, type Liveness } from "./liveness.js";
import type { MachineLowering } from "./lowering.js";
import { rewriteAllocations } from "./rewrite.js";
import { coalesceRoundTrips } from "./coalesce.js";
import { peepholeMachineCode } from "./peephole.js";
import { placeLoopHeadersAfterBodies } from "./placement.js";
import { scheduleMachineCode } from "./schedule.js";
import { selectMachineFunction } from "./select.js";
import { lowerTwoAddress } from "./two-address.js";

export interface CompiledMachineFunction {
  readonly fn: MachineFunction;
  readonly frame: FrameLayout;
  readonly liveness: Liveness;
  readonly allocation: Allocation;
}

export function compileMachineFunction(
  graph: CFGFunction,
  legality: AotLegality,
  lowering: MachineLowering,
  analyses: AnalysisManager<CFGFunction>,
  symbol: string,
): CompiledMachineFunction {
  const layout = analyses.get(dominanceAnalysisId).reversePostorder();
  const fn = selectMachineFunction(graph, legality, lowering, layout, symbol);
  scheduleMachineCode(fn, lowering);
  lowerTwoAddress(fn, lowering);
  assignPositions(fn);
  const liveness = computeLiveness(fn);
  const allocation = allocateRegisters(fn, lowering.target, liveness);
  const usedScratch = rewriteAllocations(fn, lowering.target, lowering, allocation);
  const preserved = new Set(lowering.target.abi.callingConvention.calleeSaved);
  const frame = layoutFrame(fn, lowering.target, [
    ...allocation.usedCalleeSaved,
    ...usedScratch.filter((register) => preserved.has(register)),
  ]);
  insertFrameCode(fn, frame, lowering);
  placeLoopHeadersAfterBodies(fn);
  coalesceRoundTrips(fn, lowering.target.abi.callingConvention);
  peepholeMachineCode(fn, lowering);
  return { fn, frame, liveness, allocation };
}

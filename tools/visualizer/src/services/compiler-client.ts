import { WorkerRpc } from "@tera/ui";
import type {
  BisectResult,
  LabRequest,
  LabResult,
  LabSequence,
  LabSequenceRequest,
  RunRequest,
  RunResult,
  TargetInfo,
  TierReport,
} from "../types/stage";

export class CompilerClient extends WorkerRpc {
  constructor() {
    super(new Worker(new URL("../workers/compiler-worker.ts", import.meta.url), { type: "module" }));
  }

  run(request: RunRequest): Promise<RunResult> {
    return this.call<RunResult>("run", request);
  }

  bisect(request: RunRequest): Promise<BisectResult> {
    return this.call<BisectResult>("bisect", request);
  }

  tiers(request: RunRequest): Promise<TierReport> {
    return this.call<TierReport>("tiers", request);
  }

  targets(): Promise<TargetInfo[]> {
    return this.call<TargetInfo[]>("targets");
  }

  passNames(): Promise<string[]> {
    return this.call<string[]>("passNames");
  }

  runPass(request: LabRequest): Promise<LabResult> {
    return this.call<LabResult>("runPass", request);
  }

  runPasses(request: LabSequenceRequest): Promise<LabSequence> {
    return this.call<LabSequence>("runPasses", request);
  }
}

import { WorkerRpc } from "@tera/ui";
import type { LabRequest, LabResult, RunRequest, RunResult, TargetInfo } from "../types/stage";

export class CompilerClient extends WorkerRpc {
  constructor() {
    super(new Worker(new URL("../workers/compiler-worker.ts", import.meta.url), { type: "module" }));
  }

  run(request: RunRequest): Promise<RunResult> {
    return this.call<RunResult>("run", request);
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
}

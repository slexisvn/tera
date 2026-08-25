import { WorkerRpc } from "@tera/ui";

export class KernelClient extends WorkerRpc {
  constructor() {
    super(new Worker(new URL("../workers/kernel-worker.ts", import.meta.url), { type: "module" }));
  }

  terminate(): void {
    super.terminate("Kernel restarted");
  }
}

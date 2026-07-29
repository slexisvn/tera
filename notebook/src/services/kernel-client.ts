import type { KernelRunResult } from "../types/notebook";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class KernelClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("../workers/kernel-worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data || {};
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error || "Kernel worker failed"));
    };
    this.worker.onerror = (event) => {
      this.rejectAll(new Error(event.message || "Kernel worker failed"));
    };
  }

  call<T = KernelRunResult>(type: string, payload: object = {}, transfer: Transferable[] = []) {
    const id = ++this.nextId;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.worker.postMessage({ id, type, payload }, transfer);
    return promise;
  }

  terminate() {
    this.worker.terminate();
    this.rejectAll(new Error("Kernel restarted"));
  }

  private rejectAll(error: Error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

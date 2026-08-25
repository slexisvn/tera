type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type WorkerNotice = { readonly type: string; readonly payload: unknown };

export class WorkerRpc {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly worker: Worker,
    onNotice: (notice: WorkerNotice) => void = () => undefined,
  ) {
    this.worker.onmessage = (event) => {
      const { id, ok, result, error, notice } = event.data || {};
      if (notice) {
        onNotice(notice as WorkerNotice);
        return;
      }
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error || "Worker call failed"));
    };
    this.worker.onerror = (event) => {
      this.rejectAll(new Error(event.message || "Worker failed"));
    };
  }

  call<T>(type: string, payload: object = {}, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.nextId;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.worker.postMessage({ id, type, payload }, transfer);
    return promise;
  }

  terminate(reason = "Worker terminated"): void {
    this.worker.terminate();
    this.rejectAll(new Error(reason));
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

import { describe, expect, it, vi } from "vitest";
import { WorkerRpc, type WorkerNotice } from "../src/worker-rpc";

type Sent = { id: number; type: string; payload: unknown };

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly sent: Sent[] = [];
  readonly transfers: unknown[][] = [];
  terminated = 0;

  postMessage(message: Sent, transfer: unknown[] = []): void {
    this.sent.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated++;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(message: string): void {
    this.onerror?.({ message });
  }
}

function connect(onNotice?: (notice: WorkerNotice) => void) {
  const worker = new FakeWorker();
  const rpc = new WorkerRpc(worker as unknown as Worker, onNotice);
  return { worker, rpc };
}

describe("talking to a worker over request ids", () => {
  it("sends the type and payload it was given", async () => {
    const { worker, rpc } = connect();
    const answer = rpc.call<number>("run", { source: "x" });
    worker.reply({ id: worker.sent[0]!.id, ok: true, result: 7 });

    await expect(answer).resolves.toBe(7);
    expect(worker.sent[0]).toMatchObject({ type: "run", payload: { source: "x" } });
  });

  it("defaults the payload so a call with no arguments still has a shape", async () => {
    const { worker, rpc } = connect();
    void rpc.call("targets");

    expect(worker.sent[0]!.payload).toEqual({});
  });

  it("hands each call its own id, so two in flight cannot collide", async () => {
    const { worker, rpc } = connect();
    const first = rpc.call<string>("a");
    const second = rpc.call<string>("b");

    expect(worker.sent.map((message) => message.id)).toEqual([1, 2]);

    worker.reply({ id: 2, ok: true, result: "second" });
    worker.reply({ id: 1, ok: true, result: "first" });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("rejects with the message the worker reported", async () => {
    const { worker, rpc } = connect();
    const answer = rpc.call("run");
    worker.reply({ id: 1, ok: false, error: "no function collected feedback" });

    await expect(answer).rejects.toThrow("no function collected feedback");
  });

  it("still rejects when the worker refuses without saying why", async () => {
    const { worker, rpc } = connect();
    const answer = rpc.call("run");
    worker.reply({ id: 1, ok: false });

    await expect(answer).rejects.toThrow("Worker call failed");
  });

  it("passes a notice to the listener instead of settling a call", async () => {
    const seen: WorkerNotice[] = [];
    const { worker, rpc } = connect((notice) => seen.push(notice));
    const answer = rpc.call<string>("run");

    worker.reply({ notice: { type: "trace", payload: { at: 1 } } });
    expect(seen).toEqual([{ type: "trace", payload: { at: 1 } }]);

    worker.reply({ id: 1, ok: true, result: "done" });
    await expect(answer).resolves.toBe("done");
  });

  it("ignores an answer for an id nobody is waiting on", () => {
    const { worker } = connect();

    expect(() => worker.reply({ id: 99, ok: true, result: 1 })).not.toThrow();
    expect(() => worker.reply(null)).not.toThrow();
  });

  it("fails every call in flight when the worker itself dies", async () => {
    const { worker, rpc } = connect();
    const first = rpc.call("a");
    const second = rpc.call("b");
    worker.fail("out of memory");

    await expect(first).rejects.toThrow("out of memory");
    await expect(second).rejects.toThrow("out of memory");
  });

  it("fails every call in flight when the caller terminates it", async () => {
    const { worker, rpc } = connect();
    const answer = rpc.call("a");
    rpc.terminate("stage viewer closed");

    await expect(answer).rejects.toThrow("stage viewer closed");
    expect(worker.terminated).toBe(1);
  });

  it("does not answer a call twice, even if the worker repeats itself", async () => {
    const { worker, rpc } = connect();
    const answer = rpc.call<number>("a");
    worker.reply({ id: 1, ok: true, result: 1 });
    worker.reply({ id: 1, ok: false, error: "late failure" });

    await expect(answer).resolves.toBe(1);
  });

  it("forwards the transfer list untouched", () => {
    const { worker, rpc } = connect();
    const buffer = new ArrayBuffer(8);
    void rpc.call("send", {}, [buffer]);

    expect(worker.transfers[0]).toEqual([buffer]);
  });

  it("rejects the call rather than leaking it when the message cannot be posted", async () => {
    const worker = new FakeWorker();
    const rpc = new WorkerRpc(worker as unknown as Worker);
    vi.spyOn(worker, "postMessage").mockImplementation(() => {
      throw new DOMException("could not be cloned", "DataCloneError");
    });

    await expect(rpc.call("run", { fn: "not cloneable" })).rejects.toThrow(/cloned/);

    vi.restoreAllMocks();
    const later = rpc.call<number>("run");
    worker.reply({ id: worker.sent[0]!.id, ok: true, result: 3 });
    await expect(later).resolves.toBe(3);
  });
});

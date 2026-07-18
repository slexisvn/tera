import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type KernelValue =
  | { kind: "empty" }
  | { kind: "text"; text: string }
  | { kind: "chart"; spec: unknown }
  | { kind: "tensor"; shape: number[]; data: unknown; summary: string }
  | { kind: "dataframe"; columns: string[]; total: number; rows: Array<Record<string, unknown>> };

export type KernelResult = { prints: string[]; value: KernelValue };

type Pending = { resolve(value: KernelResult): void; reject(error: Error): void };

type KernelMessage =
  | { type: "ready" }
  | { id: number; ok: true; result: KernelResult }
  | { id: number; ok: false; error?: string };

export class KernelProcess {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;

  constructor(private readonly serverPath: string, private readonly cwd: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [this.serverPath], {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      this.process = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.consume(chunk, resolve));
      child.on("error", reject);
      child.on("exit", () => this.fail(new Error("Tera kernel exited")));
    });
    return this.ready;
  }

  private consume(chunk: string, onReady: () => void): void {
    this.buffer += chunk;

    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;

      let message: KernelMessage;
      try {
        message = JSON.parse(line) as KernelMessage;
      } catch {
        continue;
      }

      if ("type" in message && message.type === "ready") {
        onReady();
        continue;
      }
      if (!("id" in message)) continue;

      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);

      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error || "kernel error"));
    }
  }

  private fail(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.process = null;
    this.ready = null;
  }

  async execute(source: string): Promise<KernelResult> {
    await this.start();
    const id = this.nextId++;
    return new Promise<KernelResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin.write(`${JSON.stringify({ id, type: "execute", source })}\n`);
    });
  }

  dispose(): void {
    this.process?.kill();
    this.fail(new Error("Tera kernel disposed"));
  }
}

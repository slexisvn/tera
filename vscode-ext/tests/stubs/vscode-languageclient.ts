export const started: Array<{ id: string; name: string; options: unknown }> = [];
export const stopped: string[] = [];

export function resetClients(): void {
  started.length = 0;
  stopped.length = 0;
}

export const TransportKind = { stdio: 0, ipc: 1, pipe: 2, socket: 3 };

export class LanguageClient {
  constructor(
    private readonly id: string,
    private readonly name: string,
    public readonly serverOptions: unknown,
    public readonly clientOptions: unknown,
  ) {}

  async start(): Promise<void> {
    started.push({ id: this.id, name: this.name, options: this.serverOptions });
  }

  async stop(): Promise<void> {
    stopped.push(this.id);
  }
}

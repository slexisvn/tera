import type { CodeBackend } from "./backend.js";

export class UnknownBackendError extends Error {
  constructor(id: string) {
    super(`No backend registered with id "${id}"`);
    this.name = "UnknownBackendError";
  }
}

export class BackendRegistry {
  private readonly byId = new Map<string, CodeBackend>();

  register(backend: CodeBackend): void {
    this.byId.set(backend.id, backend);
  }

  resolve(id: string): CodeBackend {
    const backend = this.byId.get(id);
    if (backend === undefined) throw new UnknownBackendError(id);
    return backend;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): Iterable<CodeBackend> {
    return this.byId.values();
  }
}

import { BackendRegistry } from "../target/registry.js";
import { isJitBackend, type JitBackend } from "../target/jit.js";
import { WasmBackend } from "./wasm/backend.js";

export function createJitBackendRegistry(): BackendRegistry {
  const registry = new BackendRegistry();
  registry.register(new WasmBackend());
  return registry;
}

export function resolveJitBackend(registry: BackendRegistry, id?: string): JitBackend {
  if (id !== undefined) {
    const backend = registry.resolve(id);
    if (!isJitBackend(backend)) throw new Error(`Backend "${id}" is not a JIT backend`);
    return backend;
  }
  for (const backend of registry.list()) {
    if (isJitBackend(backend)) return backend;
  }
  throw new Error("No JIT backend is registered");
}

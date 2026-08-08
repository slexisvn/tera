import { BackendRegistry } from "../target/registry.js";
import { WasmBackend } from "./wasm/backend.js";
import { cBackend } from "./c/backend.js";

export function createBackendRegistry(): BackendRegistry {
  const registry = new BackendRegistry();
  registry.register(new WasmBackend());
  registry.register(cBackend);
  return registry;
}

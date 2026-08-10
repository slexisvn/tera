import { BackendRegistry } from "../target/registry.js";
import { WasmBackend } from "./wasm/backend.js";
import { cBackend } from "./c/backend.js";
import { x64Backend } from "./x64/backend.js";
import { riscv64Backend } from "./riscv64/backend.js";

export function createBackendRegistry(): BackendRegistry {
  const registry = new BackendRegistry();
  registry.register(new WasmBackend());
  registry.register(cBackend);
  registry.register(x64Backend);
  registry.register(riscv64Backend);
  return registry;
}

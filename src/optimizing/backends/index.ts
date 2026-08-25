import type { BackendRegistry } from "../target/registry.js";
import { createJitBackendRegistry } from "./jit.js";
import { cBackend } from "./c/backend.js";
import { createX64Backend } from "./x64/backend.js";
import { riscv64Backend } from "./riscv64/backend.js";

export function createBackendRegistry(): BackendRegistry {
  const registry = createJitBackendRegistry();
  registry.register(cBackend);
  registry.register(createX64Backend({ id: "x64-linux", abi: "sysv", format: "elf" }));
  registry.register(createX64Backend({ id: "x64-windows", abi: "win64", format: "coff" }));
  registry.register(riscv64Backend);
  return registry;
}

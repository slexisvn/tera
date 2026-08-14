import type { BackendRegistry } from "../target/registry.js";
import { isAotBackend, type TargetPlatform } from "../target/backend.js";
import { createJitBackendRegistry } from "./jit.js";
import { cBackend } from "./c/backend.js";
import { createX64Backend } from "./x64/backend.js";
import { riscv64Backend } from "./riscv64/backend.js";

const OPERATING_SYSTEMS: Readonly<Record<string, string>> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
};

export const HOST_PLATFORM: TargetPlatform = {
  os: OPERATING_SYSTEMS[process.platform] ?? process.platform,
  arch: process.arch,
};

export function createBackendRegistry(): BackendRegistry {
  const registry = createJitBackendRegistry();
  registry.register(cBackend);
  registry.register(createX64Backend({ id: "x64-linux", abi: "sysv", format: "elf" }));
  registry.register(createX64Backend({ id: "x64-windows", abi: "win64", format: "coff" }));
  registry.register(riscv64Backend);
  return registry;
}

export function hostBackendId(registry = createBackendRegistry()): string | null {
  for (const backend of registry.list()) {
    if (!isAotBackend(backend) || backend.platform === null) continue;
    if (
      backend.platform.os === HOST_PLATFORM.os &&
      backend.platform.arch === HOST_PLATFORM.arch
    ) {
      return backend.id;
    }
  }
  return null;
}

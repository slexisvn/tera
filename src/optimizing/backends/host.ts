import { isAotBackend, type TargetPlatform } from "../target/backend.js";
import { createBackendRegistry } from "./index.js";

const OPERATING_SYSTEMS: Readonly<Record<string, string>> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
};

export const HOST_PLATFORM: TargetPlatform = {
  os: OPERATING_SYSTEMS[process.platform] ?? process.platform,
  arch: process.arch,
};

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

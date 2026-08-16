import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import type { EngineOptions } from "../api/engine.js";
import type { TeraExtension } from "../api/extensions.js";
import { nodeModuleFileSystem } from "../frontend/modules/node-file-system.js";
import { createBackendRegistry } from "../optimizing/backends/index.js";
import { nativeToTagged, taggedToNative } from "../runtime/domain/host.js";

export function hostEngineOptions(): EngineOptions {
  const base = createReactiveTeraOptions({ nativeToTagged, taggedToNative });
  return {
    ...base,
    extensions: [...((base.extensions as TeraExtension[]) ?? [])],
    backends: createBackendRegistry(),
    moduleFileSystem: nodeModuleFileSystem,
  };
}

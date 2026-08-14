import { Engine, type EngineOptions } from "../../src/api/engine.js";
import { nodeModuleFileSystem } from "../../src/frontend/modules/node-file-system.js";
import { createBackendRegistry } from "../../src/optimizing/backends/index.js";

export function nodeEngine(options: EngineOptions = {}): Engine {
  return new Engine({
    backends: createBackendRegistry(),
    moduleFileSystem: nodeModuleFileSystem,
    ...options,
  });
}

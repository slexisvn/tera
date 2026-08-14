export * from "./index.browser.js";
export { compileModule } from "./optimizing/drivers/aot.js";
export type { AotDriverOptions, AotProgram, AotSkippedFunction } from "./optimizing/drivers/aot.js";
export { writeAotProgram } from "./optimizing/drivers/write.js";
export { createBackendRegistry, hostBackendId, HOST_PLATFORM } from "./optimizing/backends/index.js";
export type { AotBackend } from "./optimizing/target/backend.js";
export { nodeModuleFileSystem } from "./frontend/modules/node-file-system.js";

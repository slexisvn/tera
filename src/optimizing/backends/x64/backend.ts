import type { AotBackend } from "../../target/backend.js";
import { createNativeBackend } from "../../machine/backend.js";
import { X64AssemblyWriter } from "./assembly.js";
import { X64Lowering } from "./lowering.js";
import { x64Target, type X64TargetOptions } from "./target.js";

export const X64_HEADER_PREAMBLE = "#include <stdint.h>";

export function createX64Backend(options: X64TargetOptions = {}): AotBackend {
  const target = x64Target(options);
  return createNativeBackend({
    id: "x64",
    lowering: new X64Lowering(target),
    writer: new X64AssemblyWriter(target),
    headerPreamble: X64_HEADER_PREAMBLE,
  });
}

export const x64Backend: AotBackend = createX64Backend();

import type { AotBackend } from "../../target/backend.js";
import { createNativeBackend } from "../../machine/backend.js";
import { RiscvAssemblyWriter } from "./assembly.js";
import { RiscvLowering } from "./lowering.js";
import { riscvTarget } from "./target.js";

export const RISCV_HEADER_PREAMBLE = "#include <stdint.h>";

export function createRiscvBackend(): AotBackend {
  const target = riscvTarget();
  return createNativeBackend({
    id: "riscv64",
    lowering: new RiscvLowering(target),
    writer: new RiscvAssemblyWriter(),
    headerPreamble: RISCV_HEADER_PREAMBLE,
  });
}

export const riscv64Backend: AotBackend = createRiscvBackend();

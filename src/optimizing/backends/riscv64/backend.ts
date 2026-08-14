import type { AotBackend } from "../../target/backend.js";
import { createNativeBackend } from "../../machine/backend.js";
import { RiscvAssemblyWriter } from "./assembly.js";
import { RiscvLowering } from "./lowering.js";
import { riscvTarget } from "./target.js";

export const RISCV_HEADER_PREAMBLE = "#include <stdint.h>";

const RISCV_TARGET_ID = "riscv64";
const RISCV_OPERATING_SYSTEM = "linux";

export function createRiscvBackend(): AotBackend {
  const target = riscvTarget();
  return createNativeBackend({
    id: RISCV_TARGET_ID,
    platform: { os: RISCV_OPERATING_SYSTEM, arch: RISCV_TARGET_ID },
    lowering: new RiscvLowering(target),
    writer: new RiscvAssemblyWriter(),
    headerPreamble: RISCV_HEADER_PREAMBLE,
    machineCode: null,
  });
}

export const riscv64Backend: AotBackend = createRiscvBackend();

import { mem, sym, type MachineOperand, type RegisterOperand } from "../../machine/ir.js";
import { TERA_CONTEXT, type TeraContextField } from "../../target/runtime-layout.js";

export function contextAddress(): MachineOperand {
  return sym(TERA_CONTEXT.symbol);
}

export function contextField(base: RegisterOperand, name: TeraContextField): MachineOperand {
  const field = TERA_CONTEXT.field(name);
  return mem(field.bytes, { base, displacement: field.offset });
}

export function contextWidthOf(name: TeraContextField): number {
  return TERA_CONTEXT.field(name).bytes;
}

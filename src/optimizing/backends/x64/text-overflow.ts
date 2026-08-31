import { asciiData } from "../../machine/data.js";
import { imm, mem } from "../../machine/ir.js";
import type { MachineRoutineBuilder } from "../../machine/routine.js";
import { calleeFrameBytes, type RuntimeAbi } from "../../target/abi.js";
import { TERA_TEXT_OVERFLOW } from "../../target/faults.js";
import { x64IntegerArgumentNames } from "./abi.js";
import { X64_RUNTIME_SYMBOLS } from "./runtime-symbols.js";

const TEXT_OVERFLOW_KEY = "text-overflow";
const NO_SAVED_REGISTERS = 0;

export function reportTextOverflow(builder: MachineRoutineBuilder, abi: RuntimeAbi): void {
  const [message] = x64IntegerArgumentNames(abi);
  const text = builder.data(TEXT_OVERFLOW_KEY, 1, [asciiData(TERA_TEXT_OVERFLOW)]);
  builder
    .emit("subq", builder.write("rsp", 8), imm(calleeFrameBytes(abi, NO_SAVED_REGISTERS)))
    .emit("leaq", builder.write(message!, 8), mem(1, { symbol: text.label }))
    .callSymbol(X64_RUNTIME_SYMBOLS.throwError);
}

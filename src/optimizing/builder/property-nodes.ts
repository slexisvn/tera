import * as ir from "../ir/index.js";
import type {
  RegisterCompiledFunction,
  RegisterInstruction,
} from "../../bytecode/register/ops/bytecode.js";
import { constantString } from "./feedback-utils.js";

type NodeLookup = {
  get(slot: number): ir.CFGInstruction | null | undefined;
};

export function genericDeletePropNode(
  instruction: RegisterInstruction,
  compiledFn: RegisterCompiledFunction,
  regs: NodeLookup,
): ir.CFGInstruction {
  const objReg = instruction.operands[0];
  const propNameIdx = instruction.operands[1];
  const keyReg = instruction.operands.length > 2 ? instruction.operands[2] : -1;
  const obj = regs.get(objReg) || ir.irConstant(undefined);
  if (keyReg >= 0) {
    return ir.irGenericDeleteProp(
      obj,
      regs.get(keyReg) || ir.irConstant(undefined),
    );
  }
  return ir.irGenericDeleteProp(
    obj,
    constantString(compiledFn.constants, propNameIdx),
  );
}

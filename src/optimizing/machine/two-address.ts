import { def, use, type MachineFunction, type MachineInstruction } from "./ir.js";
import type { MachineLowering } from "./lowering.js";

export function lowerTwoAddress(
  fn: MachineFunction,
  lowering: MachineLowering,
): number {
  let inserted = 0;
  for (const block of fn.blocks) {
    const rewritten: MachineInstruction[] = [];
    for (const node of block.instructions) {
      if (node.flags.tied === true) {
        const destination = node.operands[0];
        const source = node.operands[1];
        if (
          destination === undefined ||
          destination.kind !== "register" ||
          destination.role !== "def" ||
          source === undefined ||
          source.kind !== "register" ||
          source.role !== "use"
        ) {
          throw new Error(`${node.opcode} is tied but is not in destructive form`);
        }
        if (destination.register !== source.register) {
          rewritten.push(
            lowering.copy(
              def(destination.register, destination.width),
              use(source.register, source.width),
            ),
          );
          source.register = destination.register;
          inserted++;
        }
      }
      rewritten.push(node);
    }
    block.instructions.length = 0;
    block.instructions.push(...rewritten);
  }
  return inserted;
}

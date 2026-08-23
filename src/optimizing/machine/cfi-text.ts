import { cfiDirectives, type CfiTarget, type PrologueEffect } from "../mc/dwarf/eh-frame.js";
import type { MachineFunction, MachineInstruction } from "./ir.js";

export const CFI_START = "\t.cfi_startproc";
export const CFI_END = "\t.cfi_endproc";

export type PrologueReader = (node: MachineInstruction) => PrologueEffect | null;

export interface CfiAnnotation {
  readonly describes: boolean;
  after(node: MachineInstruction): readonly string[];
}

const SILENT: CfiAnnotation = { describes: false, after: () => [] };

function prologueOf(fn: MachineFunction): MachineInstruction[] {
  return fn.blocks.flatMap((block) =>
    block.instructions.filter((node) => node.flags.prologue === true),
  );
}

export function annotateCfi(
  fn: MachineFunction,
  target: CfiTarget,
  read: PrologueReader,
): CfiAnnotation {
  const prologue = prologueOf(fn);
  if (prologue.length === 0) return SILENT;
  const effects: PrologueEffect[] = [];
  for (const node of prologue) {
    const effect = read(node);
    if (effect === null) return SILENT;
    effects.push(effect);
  }
  const directives = cfiDirectives(effects, target);
  if (directives === null) return SILENT;
  const lines = new Map<MachineInstruction, readonly string[]>();
  prologue.forEach((node, position) => lines.set(node, directives[position]!));
  return { describes: true, after: (node) => lines.get(node) ?? [] };
}

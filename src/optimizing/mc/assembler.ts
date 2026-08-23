import { machineDataBytes } from "../machine/data.js";
import type { MachineDatum, MachineFunction, MachineInstruction } from "../machine/ir.js";
import {
  type McInstructionFragment,
  alignFragment,
  bytesFragment,
  instructionFragment,
  type McFragment,
} from "./fragment.js";
import type { McModule } from "./module.js";
import type { McSection, SectionKind } from "./section.js";
import type { SymbolBinding } from "./symbol.js";
import type { McTarget } from "./target.js";
import type { SourceLine } from "./dwarf/line-table.js";

export const TEXT_SECTION = ".text";
export const RODATA_SECTION = ".rodata";
export const DATA_SECTION = ".data";
export const BSS_SECTION = ".bss";

export interface AssembledFunction {
  readonly section: McSection;
  readonly entry: McFragment;
  readonly end: McFragment;
  readonly prologue: readonly McInstructionFragment[];
  readonly lines: readonly SourceLine[];
  readonly instructions: number;
}

function locate(
  lines: SourceLine[],
  fragment: McInstructionFragment,
  node: MachineInstruction,
): void {
  const source = node.source;
  if (source === null || source.file.length === 0) return;
  const previous = lines[lines.length - 1]?.source;
  if (
    previous !== undefined &&
    previous.file === source.file &&
    previous.line === source.line &&
    previous.column === source.column
  ) {
    return;
  }
  lines.push({ fragment, source });
}

function anchor(section: McSection): McFragment {
  return section.add(bytesFragment([]));
}

function place(
  module: McModule,
  target: McTarget,
  section: McSection,
  node: MachineInstruction,
): McInstructionFragment {
  const encoding = target.encode(node, 0);
  for (const entry of encoding.fixups) module.symbols.reference(entry.symbol);
  const fragment = instructionFragment(node, encoding);
  section.add(fragment);
  return fragment;
}

export function assembleFunction(
  module: McModule,
  target: McTarget,
  fn: MachineFunction,
  binding: SymbolBinding = "global",
): AssembledFunction {
  const section = module.section(TEXT_SECTION, "text", target.functionAlignment);
  section.padding = target.padding;
  section.add(alignFragment(target.functionAlignment));
  const entry = anchor(section);
  module.symbols.define(fn.symbol, entry, binding, "function");

  const prologue: McInstructionFragment[] = [];
  const lines: SourceLine[] = [];
  let instructions = 0;
  for (const block of fn.blocks) {
    module.symbols.define(block.label, anchor(section), "local", "none");
    for (const node of block.instructions) {
      const fragment = place(module, target, section, node);
      if (node.flags.prologue === true) prologue.push(fragment);
      locate(lines, fragment, node);
      instructions++;
    }
  }
  return { section, entry, end: anchor(section), prologue, lines, instructions };
}

function isUninitialized(datum: MachineDatum): boolean {
  return datum.writable && datum.items.every((item) => item.kind === "zero");
}

function sectionFor(datum: MachineDatum): readonly [string, SectionKind] {
  if (isUninitialized(datum)) return [BSS_SECTION, "bss"];
  return datum.writable ? [DATA_SECTION, "data"] : [RODATA_SECTION, "rodata"];
}

export function assembleData(module: McModule, items: readonly MachineDatum[]): void {
  for (const datum of items) {
    const [name, kind] = sectionFor(datum);
    const section = module.section(name, kind, datum.alignment);
    section.add(alignFragment(datum.alignment));
    const anchor = section.add(bytesFragment(machineDataBytes(datum.items)));
    module.symbols.define(datum.label, anchor, "local", "object");
  }
}

export function assembleRoutine(
  module: McModule,
  target: McTarget,
  symbol: string,
  body: readonly MachineInstruction[],
  binding: SymbolBinding = "local",
): AssembledFunction {
  const section = module.section(TEXT_SECTION, "text", target.functionAlignment);
  section.padding = target.padding;
  section.add(alignFragment(target.functionAlignment));
  const entry = anchor(section);
  module.symbols.define(symbol, entry, binding, "function");
  for (const node of body) place(module, target, section, node);
  return {
    section,
    entry,
    end: anchor(section),
    prologue: [],
    lines: [],
    instructions: body.length,
  };
}

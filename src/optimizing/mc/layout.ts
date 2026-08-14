import { FixupOutOfRangeError, RelaxationLimitError } from "./errors.js";
import type { McFixup } from "./fixup.js";
import {
  fixupsOf,
  writableBytesOf,
  type McFragment,
  type McInstructionFragment,
} from "./fragment.js";
import type { McModule } from "./module.js";
import { assignFragmentAddresses, type McSection } from "./section.js";
import type { McSymbolTable } from "./symbol.js";
import type { McTarget } from "./target.js";

export type LayoutMode = "image" | "object";

export interface LayoutOptions {
  readonly base?: number;
  readonly mode?: LayoutMode;
}

export interface LayoutResult {
  readonly passes: number;
  readonly relaxations: number;
  readonly size: number;
}

function assignAddresses(module: McModule, base: number): number {
  let cursor = base;
  for (const section of module.sections) {
    cursor = assignFragmentAddresses(section, cursor);
  }
  return cursor;
}

function ownerOfFragments(module: McModule): Map<McFragment, McSection> {
  const owners = new Map<McFragment, McSection>();
  for (const section of module.sections) {
    for (const fragment of section.fragments) owners.set(fragment, section);
  }
  return owners;
}

function bindsAtLayout(
  entry: McFixup,
  fragment: McFragment,
  module: McModule,
  owners: Map<McFragment, McSection>,
  mode: LayoutMode,
): boolean {
  const symbol = module.symbols.lookup(entry.symbol);
  if (symbol === undefined || symbol.definition === null) return false;
  if (mode === "image") return true;
  if (symbol.binding !== "local") return false;
  return owners.get(symbol.definition.fragment) === owners.get(fragment);
}

function anchorBias(
  entry: McFixup,
  fragment: McFragment,
  target: McTarget,
): number {
  const anchor = target.fixups.anchorOf(entry.kind);
  if (anchor === "absolute") return 0;
  if (anchor === "instructionEnd") return fragment.size - entry.offset;
  return -entry.offset;
}

function fixupValue(
  entry: McFixup,
  fragment: McFragment,
  symbols: McSymbolTable,
  target: McTarget,
): number | null {
  const address = symbols.addressOf(entry.symbol);
  if (address === null) return null;
  const anchor = target.fixups.anchorOf(entry.kind);
  if (anchor === "absolute") return address + entry.addend;
  const origin =
    anchor === "instructionStart" ? fragment.address : fragment.address + fragment.size;
  return address + entry.addend - origin;
}

function relaxFragment(
  fragment: McInstructionFragment,
  module: McModule,
  owners: Map<McFragment, McSection>,
  mode: LayoutMode,
  target: McTarget,
): boolean {
  const forms = target.formsOf(fragment.node);
  let widened = false;
  while (fragment.form + 1 < forms) {
    const pending = fragment.fixups.find((entry) => {
      if (!bindsAtLayout(entry, fragment, module, owners, mode)) return true;
      const value = fixupValue(entry, fragment, module.symbols, target);
      return value !== null && !target.fixups.fits(entry.kind, value);
    });
    if (pending === undefined) break;
    fragment.form += 1;
    const encoding = target.encode(fragment.node, fragment.form);
    fragment.bytes = [...encoding.bytes];
    fragment.fixups = encoding.fixups;
    fragment.size = fragment.bytes.length;
    widened = true;
  }
  return widened;
}

function relaxPass(
  module: McModule,
  owners: Map<McFragment, McSection>,
  mode: LayoutMode,
  target: McTarget,
): number {
  let relaxations = 0;
  for (const section of module.sections) {
    for (const fragment of section.fragments) {
      if (fragment.kind !== "instruction") continue;
      if (relaxFragment(fragment, module, owners, mode, target)) relaxations++;
    }
  }
  return relaxations;
}

function applyFixups(
  module: McModule,
  owners: Map<McFragment, McSection>,
  mode: LayoutMode,
  target: McTarget,
): void {
  for (const section of module.sections) {
    for (const fragment of section.fragments) {
      const bytes = writableBytesOf(fragment);
      if (bytes === null) continue;
      for (const entry of fixupsOf(fragment)) {
        const value = bindsAtLayout(entry, fragment, module, owners, mode)
          ? fixupValue(entry, fragment, module.symbols, target)
          : null;
        if (value === null) {
          module.relocations.push({
            section,
            offset: fragment.address - section.address + entry.offset,
            symbol: entry.symbol,
            kind: entry.kind,
            addend: entry.addend - anchorBias(entry, fragment, target),
          });
          continue;
        }
        if (!target.fixups.fits(entry.kind, value)) {
          if (fragment.kind === "instruction") {
            throw new RelaxationLimitError(fragment.node.opcode, entry.kind);
          }
          throw new FixupOutOfRangeError(entry.kind, value);
        }
        target.fixups.apply(entry.kind, bytes, entry.offset, value);
      }
    }
  }
}

export function layoutModule(
  module: McModule,
  target: McTarget,
  options: LayoutOptions = {},
): LayoutResult {
  const base = options.base ?? 0;
  const mode = options.mode ?? "image";
  const owners = ownerOfFragments(module);
  let passes = 0;
  let relaxations = 0;
  let size = assignAddresses(module, base);
  for (;;) {
    passes++;
    const widened = relaxPass(module, owners, mode, target);
    if (widened === 0) break;
    relaxations += widened;
    size = assignAddresses(module, base);
  }
  applyFixups(module, owners, mode, target);
  return { passes, relaxations, size: size - base };
}

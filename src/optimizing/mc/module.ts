import type { FixupKind } from "./fixup.js";
import { McSection, type SectionKind } from "./section.js";
import { McSymbolTable } from "./symbol.js";

export interface McRelocation {
  readonly section: McSection;
  readonly offset: number;
  readonly symbol: string;
  readonly kind: FixupKind;
  readonly addend: number;
}

export class McModule {
  readonly symbols = new McSymbolTable();
  readonly relocations: McRelocation[] = [];
  readonly afterLayout: Array<() => void> = [];
  private readonly byName = new Map<string, McSection>();
  private readonly ordered: McSection[] = [];

  section(name: string, kind: SectionKind, alignment = 1): McSection {
    const existing = this.byName.get(name);
    if (existing !== undefined) {
      existing.require(alignment);
      return existing;
    }
    const created = new McSection(name, kind, alignment);
    this.byName.set(name, created);
    this.ordered.push(created);
    return created;
  }

  get sections(): readonly McSection[] {
    return this.ordered;
  }

  get nonEmptySections(): readonly McSection[] {
    return this.ordered.filter((section) => section.fragments.length > 0);
  }
}

export function relocationsBySection(
  module: McModule,
): ReadonlyMap<McSection, readonly McRelocation[]> {
  const grouped = new Map<McSection, McRelocation[]>();
  for (const entry of module.relocations) {
    const bucket = grouped.get(entry.section);
    if (bucket === undefined) grouped.set(entry.section, [entry]);
    else bucket.push(entry);
  }
  return grouped;
}

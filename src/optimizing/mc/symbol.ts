import { UndefinedSymbolError } from "./errors.js";
import type { McFragment } from "./fragment.js";

export type SymbolBinding = "local" | "global";

export type SymbolKind = "function" | "object" | "none";

export interface McSymbolDefinition {
  readonly fragment: McFragment;
}

export interface McSymbol {
  readonly name: string;
  binding: SymbolBinding;
  kind: SymbolKind;
  definition: McSymbolDefinition | null;
}

export class McSymbolTable {
  private readonly byName = new Map<string, McSymbol>();

  reference(name: string): McSymbol {
    const existing = this.byName.get(name);
    if (existing !== undefined) return existing;
    const created: McSymbol = {
      name,
      binding: "local",
      kind: "none",
      definition: null,
    };
    this.byName.set(name, created);
    return created;
  }

  define(
    name: string,
    fragment: McFragment,
    binding: SymbolBinding,
    kind: SymbolKind,
  ): McSymbol {
    const symbol = this.reference(name);
    symbol.definition = { fragment };
    symbol.binding = binding;
    symbol.kind = kind;
    return symbol;
  }

  lookup(name: string): McSymbol | undefined {
    return this.byName.get(name);
  }

  addressOf(name: string): number | null {
    const symbol = this.byName.get(name);
    if (symbol === undefined) throw new UndefinedSymbolError(name);
    if (symbol.definition === null) return null;
    return symbol.definition.fragment.address;
  }

  get symbols(): readonly McSymbol[] {
    return [...this.byName.values()];
  }

  get undefinedSymbols(): readonly McSymbol[] {
    return this.symbols.filter((symbol) => symbol.definition === null);
  }
}

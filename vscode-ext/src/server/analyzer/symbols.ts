import { buildSourceSymbolTable } from "../../../../src/frontend/index.ts";
import type { SyntaxPlugin } from "../../../../src/frontend/index.ts";
import type { SymbolTable } from "./types.ts";

export function buildSymbolTable(source: string, inferredSymbols: Iterable<{ name: string; line: number; column: number; type: string }>, syntaxPlugins: readonly SyntaxPlugin[] = []): SymbolTable {
  return buildSourceSymbolTable(source, inferredSymbols, { syntaxPlugins });
}

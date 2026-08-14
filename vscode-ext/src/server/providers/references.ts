import type { Location, ReferenceParams } from "vscode-languageserver/node.js";
import { isStringLiteralTextPosition } from "tera/frontend";
import { nameOccurrences } from "../analyzer/occurrences.ts";
import { wordRangeAt } from "../analyzer/position.ts";
import { moduleSymbolAt } from "./module-symbol.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

export default defineProvider({
  id: "references",
  register(connection, context) {
    connection.onReferences((params): Location[] | null => {
      try {
        return computeReferences(context, params);
      } catch (error) {
        connection.console.error(`references error: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  },
});

export function computeReferences(context: ProviderContext, params: ReferenceParams): Location[] | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return null;
  if (isStringLiteralTextPosition(document.text, params.position)) return null;

  const word = wordRangeAt(document.lines, params.position);
  if (!word) return null;

  const symbol = moduleSymbolAt(context, params.textDocument.uri, document, params.position, word.text);
  if (symbol === null) {
    return nameOccurrences(document.text, word.text).map((range) => ({
      uri: params.textDocument.uri,
      range,
    }));
  }

  const locations: Location[] = [];
  const targets = context.modules.referenceTargets(
    symbol.entryPath,
    symbol.ownerPath,
    symbol.name,
    true,
    symbol.declaration,
  );
  for (const target of targets) {
    const uri = context.modules.uriFor(target.path);
    const source = context.modules.sourceAt(target.path);
    for (const range of nameOccurrences(source, target.name, target.namespaces, target.plain)) {
      if (!params.context.includeDeclaration && isDeclaration(target, range)) continue;
      locations.push({ uri, range });
    }
  }
  return locations;
}

function isDeclaration(
  target: { declaration: { line: number; character: number } | null },
  range: { start: { line: number; character: number } },
): boolean {
  return target.declaration !== null
    && target.declaration.line === range.start.line
    && target.declaration.character === range.start.character;
}

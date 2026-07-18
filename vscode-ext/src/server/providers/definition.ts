import type { Location } from "vscode-languageserver/node.js";
import { wordRangeAt } from "../analyzer/position.ts";
import { defineProvider } from "./types.ts";

export default defineProvider({
  id: "definition",
  register(connection, context) {
    connection.onDefinition((params): Location | null => {
      try {
        const document = context.analyzer.get(params.textDocument.uri);
        if (!document) return null;

        const word = wordRangeAt(document.lines, params.position);
        if (!word) return null;

        const symbol = document.symbols.resolve(word.text, params.position);
        if (!symbol) return null;

        const line = Math.max(0, symbol.line - 1);
        const character = Math.max(0, symbol.column - 1);
        return {
          uri: params.textDocument.uri,
          range: {
            start: { line, character },
            end: { line, character: character + symbol.name.length },
          },
        };
      } catch (error) {
        connection.console.error(`definition error: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  },
});

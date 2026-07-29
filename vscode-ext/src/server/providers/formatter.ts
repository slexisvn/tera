import type { TextEdit } from "vscode-languageserver/node.js";
import { defineProvider } from "./types.ts";

export default defineProvider({
  id: "formatter",
  register(connection, context) {
    connection.onDocumentFormatting((params): TextEdit[] => {
      const document = context.analyzer.get(params.textDocument.uri);
      if (!document) return [];

      const formatted = format(document.lines);
      if (formatted === document.text) return [];

      const lastLine = document.lines.length - 1;
      return [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: Math.max(0, lastLine), character: document.lines[lastLine]?.length ?? 0 },
        },
        newText: formatted,
      }];
    });
  },
});

function format(lines: string[]): string {
  return lines.map((line) => line.replace(/[\t ]+$/, "")).join("\n");
}

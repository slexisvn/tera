import type { DefinitionParams, Location } from "vscode-languageserver/node.js";
import type { AnalyzedDocument, Position } from "../analyzer/index.ts";
import { wordRangeAt } from "../analyzer/position.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

export default defineProvider({
  id: "definition",
  register(connection, context) {
    connection.onDefinition((params): Location | null => {
      try {
        return computeDefinition(context, params);
      } catch (error) {
        connection.console.error(`definition error: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  },
});

export function computeDefinition(context: ProviderContext, params: DefinitionParams): Location | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return null;

  const word = wordRangeAt(document.lines, params.position);
  if (!word) return null;

  if (isMemberAccess(document, params.position)) {
    const receiver = readReceiver(document, params.position);
    if (!receiver) return null;
    const receiverType = document.symbols.resolve(receiver, params.position)?.typeName ?? receiver;
    const field = document.symbols.resolveField(receiverType, word.text);
    return field ? location(params.textDocument.uri, field.name, field.line, field.column) : null;
  }

  const symbol = document.symbols.resolve(word.text, params.position);
  return symbol ? location(params.textDocument.uri, symbol.name, symbol.line, symbol.column) : null;
}

function location(uri: string, name: string, lineOneBased: number, columnOneBased: number): Location {
  const line = Math.max(0, lineOneBased - 1);
  const character = Math.max(0, columnOneBased - 1);
  return {
    uri,
    range: {
      start: { line, character },
      end: { line, character: character + name.length },
    },
  };
}

function isMemberAccess(document: AnalyzedDocument, position: Position): boolean {
  const line = document.lines[position.line] ?? "";
  return /\.\s*[A-Za-z0-9_$]*$/.test(line.slice(0, position.character));
}

function readReceiver(document: AnalyzedDocument, position: Position): string | null {
  const line = document.lines[position.line] ?? "";
  const before = line.slice(0, position.character);
  return before.match(/([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z0-9_$]*$/)?.[1] ?? null;
}

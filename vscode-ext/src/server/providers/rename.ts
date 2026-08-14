import type { RenameParams, TextEdit, WorkspaceEdit } from "vscode-languageserver/node.js";
import { isStringLiteralTextPosition } from "tera/frontend";
import { nameOccurrences } from "../analyzer/occurrences.ts";
import { wordRangeAt } from "../analyzer/position.ts";
import { moduleSymbolAt } from "./module-symbol.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export default defineProvider({
  id: "rename",
  register(connection, context) {
    connection.onRenameRequest((params): WorkspaceEdit | null => {
      try {
        return computeRename(context, params);
      } catch (error) {
        connection.console.error(`rename error: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  },
});

export function computeRename(context: ProviderContext, params: RenameParams): WorkspaceEdit | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document || !IDENTIFIER.test(params.newName)) return null;
  if (isStringLiteralTextPosition(document.text, params.position)) return null;

  const word = wordRangeAt(document.lines, params.position);
  if (!word || word.text === params.newName) return null;

  const changes: Record<string, TextEdit[]> = {};
  const add = (uri: string, edits: TextEdit[]): void => {
    if (edits.length === 0) return;
    changes[uri] = [...(changes[uri] ?? []), ...edits];
  };

  const symbol = moduleSymbolAt(context, params.textDocument.uri, document, params.position, word.text);
  if (symbol === null || symbol.name !== word.text) {
    add(params.textDocument.uri, edits(document.text, word.text, new Set(), true, params.newName));
    return Object.keys(changes).length === 0 ? null : { changes };
  }

  const targets = context.modules.referenceTargets(
    symbol.entryPath,
    symbol.ownerPath,
    symbol.name,
    false,
    symbol.declaration,
  );
  for (const target of targets) {
    const source = context.modules.sourceAt(target.path);
    add(
      context.modules.uriFor(target.path),
      edits(source, target.name, target.namespaces, target.plain, params.newName),
    );
  }
  return Object.keys(changes).length === 0 ? null : { changes };
}

function edits(
  source: string,
  name: string,
  namespaces: ReadonlySet<string>,
  plain: boolean,
  newText: string,
): TextEdit[] {
  return nameOccurrences(source, name, namespaces, plain).map((range) => ({ range, newText }));
}

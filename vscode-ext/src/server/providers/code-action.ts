import {
  CodeActionKind,
  type CodeAction,
  type CodeActionParams,
  type Diagnostic,
  type TextEdit,
} from "vscode-languageserver/node.js";
import { importsIn, type ImportSyntax } from "../analyzer/import-syntax.ts";
import { pathOfUri } from "../analyzer/paths.ts";
import type { AnalyzedDocument } from "../analyzer/types.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const UNDEFINED_NAME = /^undefined name '(.+)'$/;
const SUGGESTION_LIMIT = 8;

export default defineProvider({
  id: "codeAction",
  register(connection, context) {
    connection.onCodeAction((params): CodeAction[] => {
      try {
        return computeCodeActions(context, params);
      } catch (error) {
        connection.console.error(`codeAction error: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
  },
});

export function computeCodeActions(context: ProviderContext, params: CodeActionParams): CodeAction[] {
  const uri = params.textDocument.uri;
  const document = context.analyzer.get(uri);
  const entryPath = pathOfUri(uri);
  if (!document || entryPath === null) return [];

  const actions: CodeAction[] = [];
  const offered = new Set<string>();
  for (const diagnostic of params.context.diagnostics) {
    const match = UNDEFINED_NAME.exec(diagnostic.message);
    if (match === null) continue;
    const name = match[1]!;
    for (const spec of context.modules.modulesExporting(entryPath, name, SUGGESTION_LIMIT)) {
      const title = `Add 'from ${spec} import ${name}'`;
      if (offered.has(title)) continue;
      offered.add(title);
      actions.push({
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: { changes: { [uri]: [importEdit(document, spec, name)] } },
      });
    }
  }
  return actions;
}

function importEdit(document: AnalyzedDocument, spec: string, name: string): TextEdit {
  const statements = importsIn(document.lines);
  const existing = statements.find(
    (syntax) => syntax.form === "from" && syntax.importKeyword !== null && dottedPath(syntax) === spec,
  );
  if (existing !== undefined) {
    const last = existing.specifiers[existing.specifiers.length - 1];
    if (last !== undefined) {
      const token = last.local ?? last.imported;
      const at = { line: token.line, character: token.end };
      return { range: { start: at, end: at }, newText: `, ${name}` };
    }
  }
  const line = statements.length === 0 ? 0 : lastLineOf(statements) + 1;
  return {
    range: { start: { line, character: 0 }, end: { line, character: 0 } },
    newText: `from ${spec} import ${name}\n`,
  };
}

function dottedPath(syntax: ImportSyntax): string {
  return `${".".repeat(syntax.level)}${syntax.path.map((token) => token.text).join(".")}`;
}

function lastLineOf(statements: readonly ImportSyntax[]): number {
  let highest = 0;
  for (const syntax of statements) {
    for (const token of syntax.tokens) highest = Math.max(highest, token.line);
  }
  return highest;
}

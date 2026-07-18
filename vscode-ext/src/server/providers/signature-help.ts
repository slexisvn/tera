import type { SignatureHelp } from "vscode-languageserver/node.js";
import type { Signature } from "../../shared/language-data.ts";
import type { AnalyzedDocument, Position } from "../analyzer/index.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const CALL_PATTERN = /(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([^()]*)$/;

export default defineProvider({
  id: "signatureHelp",
  register(connection, context) {
    connection.onSignatureHelp((params): SignatureHelp | null => {
      const document = context.analyzer.get(params.textDocument.uri);
      if (!document) return null;

      const line = document.lines[params.position.line] ?? "";
      const match = line.slice(0, params.position.character).match(CALL_PATTERN);
      if (!match) return null;

      const [, receiver, callee, args] = match;
      const signature = resolveSignature(context, document, receiver, callee, params.position);
      if (!signature) return null;

      return {
        signatures: [{
          label: signature.display,
          parameters: signature.params.map((param) => ({ label: param.name })),
        }],
        activeSignature: 0,
        activeParameter: Math.min(countCommas(args), Math.max(0, signature.params.length - 1)),
      };
    });
  },
});

function resolveSignature(
  context: ProviderContext,
  document: AnalyzedDocument,
  receiver: string | undefined,
  callee: string,
  position: Position,
): Signature | null {
  if (!receiver) return context.types.builtin(callee)?.signature ?? null;

  const typeName = document.symbols.resolve(receiver, position)?.typeName ?? receiver;
  const lookup = context.types.lookupMethod(typeName, callee) ?? context.types.findUniqueMethod(callee);
  return lookup?.method.signature ?? null;
}

function countCommas(text: string): number {
  let depth = 0;
  let count = 0;
  for (const char of text) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) count++;
  }
  return count;
}

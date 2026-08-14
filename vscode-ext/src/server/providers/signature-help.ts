import type { SignatureHelp, SignatureHelpParams } from "vscode-languageserver/node.js";
import type { ExternalBuiltinSignature } from "tera/frontend";
import type { Signature } from "@/shared/language-data";
import type { AnalyzedDocument, Position } from "../analyzer/index.ts";
import { pathOfUri } from "../analyzer/paths.ts";
import { defineProvider, type ProviderContext } from "./types.ts";

const CALL_PATTERN = /(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([^()]*)$/;

export default defineProvider({
  id: "signatureHelp",
  register(connection, context) {
    connection.onSignatureHelp((params) => computeSignatureHelp(context, params));
  },
});

export function computeSignatureHelp(
  context: ProviderContext,
  params: SignatureHelpParams,
): SignatureHelp | null {
  const document = context.analyzer.get(params.textDocument.uri);
  if (!document) return null;

  const line = document.lines[params.position.line] ?? "";
  const match = line.slice(0, params.position.character).match(CALL_PATTERN);
  if (!match) return null;

  const [, receiver, callee, args] = match;
  const signature = importedSignature(context, params.textDocument.uri, document, receiver, callee!)
    ?? resolveSignature(context, document, receiver, callee!, params.position);
  if (!signature) return null;

  return {
    signatures: [{
      label: signature.display,
      parameters: signature.params.map((param) => ({ label: param.name })),
    }],
    activeSignature: 0,
    activeParameter: Math.min(countCommas(args!), Math.max(0, signature.params.length - 1)),
  };
}

function importedSignature(
  context: ProviderContext,
  uri: string,
  document: AnalyzedDocument,
  receiver: string | undefined,
  callee: string,
): Signature | null {
  const entryPath = pathOfUri(uri);
  if (entryPath === null) return null;
  const names = context.modules.importedNames(entryPath, document.lines);
  const target = receiver === undefined
    ? names.find((name) => !name.namespace && name.local === callee)
    : names.find((name) => name.namespace && name.local === receiver);
  if (target === undefined) return null;
  const external = context.modules.signatureOf(entryPath, target, receiver === undefined ? null : callee);
  return external === null ? null : toSignature(external, receiver === undefined ? callee : `${receiver}.${callee}`);
}

export function toSignature(external: ExternalBuiltinSignature, label: string): Signature {
  const params = (external.params ?? []).map((param) => ({
    name: param.name,
    type: param.type ?? null,
    optional: param.optional ?? false,
  }));
  const rendered = params
    .map((param) => `${param.name}${param.optional ? "?" : ""}${param.type === null ? "" : `: ${param.type}`}`)
    .join(", ");
  const returns = external.returns === undefined ? "" : ` -> ${external.returns}`;
  return { params, display: `${label}(${rendered})${returns}` };
}

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

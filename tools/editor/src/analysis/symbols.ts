import { createReactiveCheckOptions } from "@slexisvn/reactive/tera";
import { buildSourceSymbolTable, inferSymbolTypes, recoverMemberCompletionSource, type SymbolPosition } from "tera/frontend";
import type { TeraDocument, TeraSourceAnalysis } from "../types";

export function analyzeDocuments(documents: readonly TeraDocument[]): TeraSourceAnalysis {
  const combined = documents.map((document) => document.source).join("\n");
  const recovered = recoverMemberCompletionSource(combined);
  const options = createReactiveCheckOptions();
  const symbols = buildSourceSymbolTable(recovered, inferSafely(recovered), { syntaxPlugins: options.syntaxPlugins });
  const starts = new Map<string, number>();
  let line = 0;
  for (const document of documents) {
    starts.set(document.id, line);
    line += document.source.split("\n").length;
  }
  return {
    source: combined,
    symbols,
    positionFor(documentId, source, offset) {
      const local = positionAt(source, offset);
      return { line: (starts.get(documentId) ?? 0) + local.line, character: local.character };
    },
  };
}

function inferSafely(source: string) {
  try {
    return inferSymbolTypes(source, createReactiveCheckOptions());
  } catch {
    return [];
  }
}

function positionAt(source: string, offset: number): SymbolPosition {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

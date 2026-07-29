import { buildSourceSymbolTable, inferSymbolTypes, recoverMemberCompletionSource, type SourceSymbolTable, type SymbolPosition } from "../../../src/frontend";

export type AnalysisCell = {
  id: string;
  source: string;
};

export type NotebookSourceAnalysis = {
  source: string;
  symbols: SourceSymbolTable;
  positionFor(cellId: string, source: string, offset: number): SymbolPosition;
};

export function analyzeNotebookSource(cells: AnalysisCell[]): NotebookSourceAnalysis {
  const combined = cells.map((cell) => cell.source).join("\n");
  const recovered = recoverMemberCompletionSource(combined);
  const symbols = buildSourceSymbolTable(recovered, inferSafely(recovered));
  const starts = new Map<string, number>();
  let line = 0;
  for (const cell of cells) {
    starts.set(cell.id, line);
    line += cell.source.split("\n").length;
  }
  return {
    source: combined,
    symbols,
    positionFor(cellId, source, offset) {
      const local = positionAt(source, offset);
      return { line: (starts.get(cellId) ?? 0) + local.line, character: local.character };
    },
  };
}

function inferSafely(source: string) {
  try {
    return inferSymbolTypes(source);
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

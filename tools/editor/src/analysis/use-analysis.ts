import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisProvider, TeraDiagnostic, TeraDocument } from "../types";
import { analyzeDocuments } from "./symbols";
import { diagnoseDocuments } from "./diagnostics";

const DEFAULT_DELAY_MS = 300;
const NO_DIAGNOSTICS: readonly TeraDiagnostic[] = [];

export type TeraAnalysis = {
  readonly analysis: AnalysisProvider;
  diagnosticsFor(documentId: string): readonly TeraDiagnostic[];
};

export function useTeraAnalysis(
  documents: readonly TeraDocument[],
  delayMs = DEFAULT_DELAY_MS,
): TeraAnalysis {
  const [diagnostics, setDiagnostics] = useState(() => new Map<string, TeraDiagnostic[]>());
  const current = useRef(analyzeDocuments(documents));

  useEffect(() => {
    const snapshot = documents;
    const handle = window.setTimeout(() => {
      current.current = analyzeDocuments(snapshot);
      setDiagnostics(diagnoseDocuments(snapshot));
    }, delayMs);
    return () => window.clearTimeout(handle);
  }, [delayMs, documents]);

  const analysis = useCallback(() => current.current, []);
  const diagnosticsFor = useCallback(
    (documentId: string) => diagnostics.get(documentId) ?? NO_DIAGNOSTICS,
    [diagnostics],
  );

  return { analysis, diagnosticsFor };
}

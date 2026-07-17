import type { NotebookDiagnostic } from "../../services/diagnostics";

type DiagnosticsListProps = {
  diagnostics: NotebookDiagnostic[];
};

export function DiagnosticsList({ diagnostics }: DiagnosticsListProps) {
  return (
    <div className="diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <div className="diag" key={`${diagnostic.from}-${index}`}>{diagnostic.message}</div>
      ))}
    </div>
  );
}

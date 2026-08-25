import { TeraEditor, type TeraEditorHandle, type TeraEditorProps } from "@tera/editor";
import type { Ref } from "react";
import { RunConsole, type RunConsoleProps } from "./RunConsole";

type SourcePaneProps = {
  source: string;
  handle: Ref<TeraEditorHandle>;
  documentId: string;
  analysis: TeraEditorProps["analysis"];
  diagnostics: TeraEditorProps["diagnostics"];
  highlightedLine: number | null;
  onChange: (next: string) => void;
  console: RunConsoleProps;
};

export function SourcePane({
  source,
  handle,
  documentId,
  analysis,
  diagnostics,
  highlightedLine,
  onChange,
  console: consoleProps,
}: SourcePaneProps) {
  return (
    <aside className="source-pane">
      <TeraEditor
        value={source}
        handle={handle}
        documentId={documentId}
        analysis={analysis}
        diagnostics={diagnostics}
        highlightedLine={highlightedLine}
        onChange={onChange}
      />
      <RunConsole {...consoleProps} />
    </aside>
  );
}

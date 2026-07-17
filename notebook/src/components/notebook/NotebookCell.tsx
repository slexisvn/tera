import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, type MutableRefObject } from "react";
import { KernelClient } from "../../services/kernel-client";
import type { NotebookDiagnostic } from "../../services/diagnostics";
import type { AddCellOptions, CellOutput, CellState } from "../../types/notebook";
import { teraCodeMirrorExtensions } from "../../utils/codemirror-tera";
import { Output } from "../outputs/Output";
import { DiagnosticsList } from "./DiagnosticsList";

type NotebookCellProps = {
  cell: CellState;
  diagnostics: NotebookDiagnostic[];
  completionSource: (context: CompletionContext) => CompletionResult | null;
  onChange: (id: string, source: string) => void;
  onRun: (id: string) => Promise<CellOutput | null>;
  onAdd: (source?: string, options?: AddCellOptions) => string;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: number) => void;
  kernel: MutableRefObject<KernelClient | null>;
};

export function NotebookCell({ cell, diagnostics, completionSource, onChange, onRun, onAdd, onDelete, onMove, kernel }: NotebookCellProps) {
  const extensions = useMemo(() => [
    EditorView.lineWrapping,
    teraCodeMirrorExtensions(),
    autocompletion({ override: [completionSource] }),
    linter(() => diagnostics.map((item) => ({
      from: item.from,
      to: item.to,
      severity: item.severity,
      message: item.message,
    }))),
    EditorView.theme({
      "&": { backgroundColor: "transparent", color: "var(--text)" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "var(--code-font)", fontSize: "13.5px", lineHeight: "1.6", backgroundColor: "transparent" },
      ".cm-content": { padding: "12px 14px", minHeight: "48px", color: "var(--text)", caretColor: "var(--accent)" },
      ".cm-line": { color: "var(--text)" },
      ".cm-cursor": { borderLeftColor: "var(--accent)" },
      ".cm-dropCursor": { borderLeftColor: "var(--accent)" },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent-soft) 42%, transparent)" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
      ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent-2) 20%, transparent)" },
      ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
      ".cm-placeholder": { color: "var(--muted)" },
      ".cm-tooltip": { border: "1px solid var(--border-strong)", backgroundColor: "var(--panel)", color: "var(--text)", boxShadow: "var(--shadow)" },
      ".cm-tooltip-autocomplete ul": { fontFamily: "var(--code-font)" },
      ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
      ".cm-completionMatchedText": { color: "var(--accent)", textDecoration: "none", fontWeight: "700" },
      ".cm-diagnostic": { fontFamily: "var(--code-font)" },
      ".cm-focused": { outline: "none" },
    }, { dark: true }),
  ], [completionSource, diagnostics]);

  return (
    <div className="cell" data-cell-id={cell.id}>
      <div className="gutter">
        <div className="run-stack">
          <button className={`run${cell.running ? " running" : ""}`} type="button" title="Run this cell" disabled={cell.running} aria-busy={cell.running} onClick={() => onRun(cell.id)}>
            {!cell.running && <span className="run-icon" aria-hidden="true" />}
          </button>
          <span className="count">[{cell.executionCount || " "}]</span>
        </div>
      </div>
      <div className="main">
        <div className="editor-wrap">
          <CodeMirror
            value={cell.source}
            basicSetup={{ foldGutter: false, lineNumbers: false }}
            extensions={extensions}
            onChange={(value) => onChange(cell.id, value)}
            onKeyDown={async (event) => {
              if (event.key === "Enter" && (event.shiftKey || event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                const result = await onRun(cell.id);
                if (event.shiftKey && result?.ok) onAdd("", { afterId: cell.id, focus: true });
              }
            }}
          />
        </div>
        <DiagnosticsList diagnostics={diagnostics} />
        <Output output={cell.output} kernel={kernel} />
      </div>
      <div className="cell-tools">
        <button className="add-cell" type="button" onClick={() => onAdd("", { afterId: cell.id, focus: true })}>+ cell</button>
        <button type="button" onClick={() => onMove(cell.id, -1)}>up</button>
        <button type="button" onClick={() => onMove(cell.id, 1)}>down</button>
        <button type="button" onClick={() => onDelete(cell.id)}>delete</button>
      </div>
    </div>
  );
}

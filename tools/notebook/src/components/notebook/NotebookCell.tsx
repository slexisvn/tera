import { TERA_BASIC_SETUP, TeraEditor, type AnalysisProvider, type TeraDiagnostic } from "@tera/editor";
import type { BasicSetupOptions } from "@uiw/react-codemirror";
import { memo, type MutableRefObject } from "react";
import { KernelClient } from "@notebook/services/kernel-client";
import type { AddCellOptions, CellOutput, CellState } from "@notebook/types/notebook";
import { Output } from "../outputs/Output";

const CELL_SETUP: BasicSetupOptions = { ...TERA_BASIC_SETUP, lineNumbers: false };

type NotebookCellProps = {
  cell: CellState;
  diagnostics: readonly TeraDiagnostic[];
  completionNames: readonly string[];
  analysis: AnalysisProvider;
  onChange: (id: string, source: string) => void;
  onRun: (id: string) => Promise<CellOutput | null>;
  onAdd: (source?: string, options?: AddCellOptions) => string;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: number) => void;
  kernel: MutableRefObject<KernelClient | null>;
};

export const NotebookCell = memo(function NotebookCell({ cell, diagnostics, completionNames, analysis, onChange, onRun, onAdd, onDelete, onMove, kernel }: NotebookCellProps) {
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
        <TeraEditor
          value={cell.source}
          documentId={cell.id}
          basicSetup={CELL_SETUP}
          analysis={analysis}
          diagnostics={diagnostics}
          completionNames={completionNames}
          onChange={(value) => onChange(cell.id, value)}
          onKeyDown={async (event) => {
            if (event.key === "Enter" && (event.shiftKey || event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              const result = await onRun(cell.id);
              if (event.shiftKey && result?.ok) onAdd("", { afterId: cell.id, focus: true });
            }
          }}
        />
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
});

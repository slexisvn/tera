import { autocompletion } from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type BasicSetupOptions, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { memo, useEffect, useMemo, useRef, type KeyboardEventHandler } from "react";
import { makeCompletionSource } from "./extensions/completion";
import { applyHighlightedLine, highlightedLineExtension } from "./extensions/highlight-line";
import { teraCodeMirrorExtensions } from "./extensions/tera-language";
import { teraEditorTheme } from "./theme";
import type { AnalysisProvider, TeraDiagnostic } from "./types";

const NO_DIAGNOSTICS: readonly TeraDiagnostic[] = [];
const NO_NAMES: readonly string[] = [];
const BASIC_SETUP: BasicSetupOptions = { foldGutter: false, lineNumbers: false };

export type TeraEditorProps = {
  value: string;
  onChange: (value: string) => void;
  documentId: string;
  analysis?: AnalysisProvider;
  diagnostics?: readonly TeraDiagnostic[];
  completionNames?: readonly string[];
  readOnly?: boolean;
  basicSetup?: BasicSetupOptions;
  highlightedLine?: number | null;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
};

export const TeraEditor = memo(function TeraEditor({
  value,
  onChange,
  documentId,
  analysis,
  diagnostics = NO_DIAGNOSTICS,
  completionNames = NO_NAMES,
  readOnly = false,
  basicSetup = BASIC_SETUP,
  highlightedLine = null,
  onKeyDown,
}: TeraEditorProps) {
  const editor = useRef<ReactCodeMirrorRef>(null);
  const extensions = useMemo(() => [
    EditorView.lineWrapping,
    teraCodeMirrorExtensions({ analysis, documentId, diagnostics }),
    autocompletion({ override: [makeCompletionSource(completionNames, analysis, documentId)] }),
    linter(() => diagnostics.map((item) => ({
      from: item.from,
      to: item.to,
      severity: item.severity,
      message: item.message,
    })), { tooltipFilter: () => [] }),
    highlightedLineExtension(),
    teraEditorTheme,
  ], [analysis, completionNames, diagnostics, documentId]);

  useEffect(() => {
    const view = editor.current?.view;
    if (view === undefined) return;
    applyHighlightedLine(view, highlightedLine);
  }, [highlightedLine, value]);

  return (
    <div className="editor-wrap">
      <CodeMirror
        ref={editor}
        value={value}
        readOnly={readOnly}
        basicSetup={basicSetup}
        extensions={extensions}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
});

import { autocompletion } from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type BasicSetupOptions, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { memo, useEffect, useImperativeHandle, useMemo, useRef, type KeyboardEventHandler, type Ref } from "react";
import { makeCompletionSource } from "./extensions/completion";
import { applyHighlightedLine, highlightedLineExtension, revealLine } from "./extensions/highlight-line";
import { teraCodeMirrorExtensions } from "./extensions/tera-language";
import { TERA_BASIC_SETUP } from "./setup";
import { teraEditorTheme } from "./theme";
import type { AnalysisProvider, TeraDiagnostic } from "./types";

const NO_DIAGNOSTICS: readonly TeraDiagnostic[] = [];
const NO_NAMES: readonly string[] = [];

export type TeraEditorHandle = {
  goToLine(line: number): void;
};

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
  handle?: Ref<TeraEditorHandle>;
};

export const TeraEditor = memo(function TeraEditor({
  value,
  onChange,
  documentId,
  analysis,
  diagnostics = NO_DIAGNOSTICS,
  completionNames = NO_NAMES,
  readOnly = false,
  basicSetup = TERA_BASIC_SETUP,
  highlightedLine = null,
  onKeyDown,
  handle,
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

  useImperativeHandle(handle, () => ({
    goToLine(line: number): void {
      const view = editor.current?.view;
      if (view === undefined || line < 1 || line > view.state.doc.lines) return;
      revealLine(view, line);
      view.dispatch({ selection: { anchor: view.state.doc.line(line).from } });
      view.focus();
    },
  }), []);

  return (
    <div className="editor-wrap">
      <CodeMirror
        ref={editor}
        value={value}
        readOnly={readOnly}
        basicSetup={basicSetup}
        indentWithTab={false}
        extensions={extensions}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
});

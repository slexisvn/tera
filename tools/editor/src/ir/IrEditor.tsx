import { EditorView } from "@codemirror/view";
import CodeMirror, { type BasicSetupOptions } from "@uiw/react-codemirror";
import { memo, useMemo } from "react";
import { teraEditorTheme } from "../theme";
import { irCodeMirrorExtensions } from "./language";

const BASIC_SETUP: BasicSetupOptions = { foldGutter: false, lineNumbers: true, highlightActiveLine: false };

export type IrEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
};

export const IrEditor = memo(function IrEditor({ value, onChange, readOnly = false }: IrEditorProps) {
  const extensions = useMemo(() => [...irCodeMirrorExtensions(), teraEditorTheme, EditorView.lineWrapping], []);

  return (
    <div className="editor-wrap ir-editor">
      <CodeMirror
        value={value}
        readOnly={readOnly}
        basicSetup={BASIC_SETUP}
        extensions={extensions}
        onChange={onChange ?? (() => undefined)}
      />
    </div>
  );
});

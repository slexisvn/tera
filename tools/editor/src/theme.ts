import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export const teraEditorTheme: Extension = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--code-font)", fontSize: "13.5px", lineHeight: "1.6", backgroundColor: "transparent" },
  ".cm-content": { padding: "12px 14px", minHeight: "48px", color: "var(--text)", caretColor: "var(--accent)" },
  ".cm-line": { color: "var(--text)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent-soft) 42%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--gutter-bg)",
    color: "var(--muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "3ch" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent-soft) 42%, transparent)", color: "var(--text)" },
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
}, { dark: true });

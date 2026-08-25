import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export const setHighlightedLine = StateEffect.define<number | null>();

const lineMark = Decoration.line({ class: "cm-tera-linked-line" });

const highlightedLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlightedLine)) continue;
      const line = effect.value;
      if (line === null || line < 1 || line > transaction.state.doc.lines) {
        next = Decoration.none;
        continue;
      }
      const at = transaction.state.doc.line(line);
      next = Decoration.set([lineMark.range(at.from)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function highlightedLineExtension(): Extension {
  return highlightedLine;
}

export function applyHighlightedLine(view: EditorView, line: number | null): void {
  view.dispatch({ effects: setHighlightedLine.of(line) });
}

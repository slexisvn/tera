import { RangeSet, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutterLineClass, type DecorationSet } from "@codemirror/view";

export const setHighlightedLine = StateEffect.define<number | null>();

const LINKED_CLASS = "cm-tera-linked-line";
const lineMark = Decoration.line({ class: LINKED_CLASS });
const gutterMark = new (class extends GutterMarker {
  override elementClass = LINKED_CLASS;
})();

function gutterMarksFor(marks: DecorationSet): RangeSet<GutterMarker> {
  const lines: Range<GutterMarker>[] = [];
  for (const cursor = marks.iter(); cursor.value !== null; cursor.next()) {
    lines.push(gutterMark.range(cursor.from));
  }
  return RangeSet.of(lines);
}

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
  provide: (field) => [
    EditorView.decorations.from(field),
    gutterLineClass.from(field, gutterMarksFor),
  ],
});

export function highlightedLineExtension(): Extension {
  return highlightedLine;
}

export function applyHighlightedLine(view: EditorView, line: number | null): void {
  view.dispatch({ effects: setHighlightedLine.of(line) });
}

export function revealLine(view: EditorView, line: number | null): void {
  if (line === null || line < 1 || line > view.state.doc.lines) return;
  const at = view.state.doc.line(line);
  view.dispatch({ effects: EditorView.scrollIntoView(at.from, { y: "center" }) });
}

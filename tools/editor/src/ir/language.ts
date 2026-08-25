import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { highlightIr } from "./highlight";

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    let at = range.from;
    while (at <= range.to) {
      const line = view.state.doc.lineAt(at);
      let cursor = line.from;
      for (const token of highlightIr(line.text)) {
        if (token.cls !== "") {
          builder.add(cursor, cursor + token.text.length, Decoration.mark({ class: token.cls }));
        }
        cursor += token.text.length;
      }
      if (line.to + 1 <= at) break;
      at = line.to + 1;
    }
  }
  return builder.finish();
}

const irHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function irCodeMirrorExtensions(): Extension[] {
  return [irHighlightPlugin];
}

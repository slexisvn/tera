import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { gutterLineClass } from "@codemirror/view";
import { highlightedLineExtension, setHighlightedLine } from "../src/extensions/highlight-line";

const SOURCE = ["fn work(n: int) -> int:", "  total = 0", "  return total", "", "print(work(4))"].join("\n");

function stateWith(line: number | null, doc = SOURCE): EditorState {
  const start = EditorState.create({ doc, extensions: [highlightedLineExtension()] });
  return start.update({ effects: setHighlightedLine.of(line) }).state;
}

function markedLines(state: EditorState): number[] {
  const lines: number[] = [];
  for (const set of state.facet(gutterLineClass)) {
    for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
      lines.push(state.doc.lineAt(cursor.from).number);
    }
  }
  return lines;
}

describe("linking an IR value back to the source line it came from", () => {
  it("marks the line it was given", () => {
    expect(markedLines(stateWith(2))).toEqual([2]);
    expect(markedLines(stateWith(5))).toEqual([5]);
  });

  it("marks the gutter as well as the line, so the number lights up too", () => {
    const state = stateWith(3);
    const gutter = state.facet(gutterLineClass);

    expect(gutter.length).toBeGreaterThan(0);
    expect(markedLines(state)).toEqual([3]);
  });

  it("holds exactly one line at a time", () => {
    const first = stateWith(2);
    const second = first.update({ effects: setHighlightedLine.of(4) }).state;

    expect(markedLines(second)).toEqual([4]);
  });

  it("clears when the link is dropped", () => {
    const marked = stateWith(2);
    const cleared = marked.update({ effects: setHighlightedLine.of(null) }).state;

    expect(markedLines(cleared)).toEqual([]);
  });

  it("refuses a line number the document does not have, rather than throwing", () => {
    expect(markedLines(stateWith(0))).toEqual([]);
    expect(markedLines(stateWith(-1))).toEqual([]);
    expect(markedLines(stateWith(99))).toEqual([]);
  });

  it("follows the line when text is inserted above it", () => {
    const marked = stateWith(3);
    const shifted = marked.update({ changes: { from: 0, insert: "# a new first line\n" } }).state;

    expect(shifted.doc.line(4).text).toBe("  return total");
    expect(markedLines(shifted)).toEqual([4]);
  });

  it("stays put when text is inserted below it", () => {
    const marked = stateWith(2);
    const edited = marked.update({
      changes: { from: marked.doc.line(4).from, insert: "  x = 1\n" },
    }).state;

    expect(markedLines(edited)).toEqual([2]);
  });

  it("survives an edit on the marked line itself", () => {
    const marked = stateWith(2);
    const edited = marked.update({
      changes: { from: marked.doc.line(2).to, insert: "  # counts" },
    }).state;

    expect(markedLines(edited)).toEqual([2]);
  });

  it("adds nothing to a document nobody linked into", () => {
    const untouched = EditorState.create({ doc: SOURCE, extensions: [highlightedLineExtension()] });

    expect(markedLines(untouched)).toEqual([]);
  });
});

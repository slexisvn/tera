import { describe, expect, it } from "vitest";
import { analyzeDocuments } from "../src/analysis/symbols";
import { diagnoseDocuments } from "../src/analysis/diagnostics";
import type { TeraDocument } from "../src/types";

const CLEAN = "fn add(a: int, b: int) -> int:\n  return a + b\n";
const SHORT = "x = 1\n";
const WRONG = 'y = add("s", 1)\n';

function docs(...sources: readonly string[]): TeraDocument[] {
  return sources.map((source, at) => ({ id: `cell-${at}`, source }));
}

function linesBefore(documents: readonly TeraDocument[], index: number): number {
  return documents
    .slice(0, index)
    .reduce((total, document) => total + document.source.split("\n").length, 0);
}

describe("analysing several documents as one program", () => {
  it("joins them with a newline, the same way the checker sees them", () => {
    const documents = docs(CLEAN, SHORT);

    expect(analyzeDocuments(documents).source).toBe(documents.map((d) => d.source).join("\n"));
  });

  it("offsets a position by the lines of every document before it", () => {
    const documents = docs(CLEAN, SHORT, WRONG);
    const analysis = analyzeDocuments(documents);

    documents.forEach((document, at) => {
      expect(analysis.positionFor(document.id, document.source, 0)).toEqual({
        line: linesBefore(documents, at),
        character: 0,
      });
    });
  });

  it("counts characters within the line and starts over after a newline", () => {
    const analysis = analyzeDocuments(docs("x = 1\ny = 2\n"));

    expect(analysis.positionFor("cell-0", "x = 1\ny = 2\n", 2)).toEqual({ line: 0, character: 2 });
    expect(analysis.positionFor("cell-0", "x = 1\ny = 2\n", 8)).toEqual({ line: 1, character: 2 });
  });

  it("stops at the end of the text rather than running past it", () => {
    const source = "x = 1\ny = 2\n";
    const analysis = analyzeDocuments(docs(source));

    expect(analysis.positionFor("cell-0", source, 999)).toEqual({ line: 2, character: 0 });
  });

  it("treats a document it has never seen as starting at the top", () => {
    const analysis = analyzeDocuments(docs(CLEAN, SHORT));

    expect(analysis.positionFor("no-such-cell", SHORT, 3)).toEqual({ line: 0, character: 3 });
  });

  it("still returns a symbol table when the program does not parse", () => {
    const analysis = analyzeDocuments(docs("fn broken(:\n"));

    expect(analysis.symbols).toBeTypeOf("object");
    expect(analysis.source).toBe("fn broken(:\n");
  });

  it("handles having no documents at all", () => {
    expect(analyzeDocuments([]).source).toBe("");
  });
});

describe("the two document mappings agreeing with each other", () => {
  it("puts a document at the same place whichever mapping is asked", () => {
    const documents = docs(CLEAN, SHORT, WRONG);
    const analysis = analyzeDocuments(documents);
    const found = diagnoseDocuments(documents);

    const reported = found.get("cell-2") ?? [];
    expect(reported.length).toBe(1);
    expect(WRONG.slice(0, reported[0]!.from)).not.toContain("\n");

    expect(analysis.positionFor("cell-2", WRONG, reported[0]!.from).line).toBe(
      linesBefore(documents, 2),
    );
  });

  it("keeps agreeing when a document above it grows", () => {
    const documents = docs(`${CLEAN}\n# a note\n`, SHORT, WRONG);
    const analysis = analyzeDocuments(documents);
    const reported = (diagnoseDocuments(documents).get("cell-2") ?? [])[0];

    expect(reported).toBeDefined();
    expect(WRONG.slice(reported!.from, reported!.to)).toBe('"s"');
    expect(analysis.positionFor("cell-2", WRONG, reported!.from).line).toBe(linesBefore(documents, 2));
  });
});

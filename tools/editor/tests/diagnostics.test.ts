import { describe, expect, it } from "vitest";
import { diagnoseDocuments } from "../src/analysis/diagnostics";
import type { TeraDocument } from "../src/types";

const CLEAN = "fn add(a: int, b: int) -> int:\n  return a + b\n";
const BROKEN = "fn broken(:\n  return 1\n";
const LATE = 'fn add(a: int, b: int) -> int:\n  return a + b\n\nx = add("s", 1)\n';

function docs(...sources: readonly string[]): TeraDocument[] {
  return sources.map((source, at) => ({ id: `cell-${at}`, source }));
}

function pointedAt(documents: readonly TeraDocument[], id: string): readonly string[] {
  const found = diagnoseDocuments(documents).get(id) ?? [];
  const source = documents.find((document) => document.id === id)!.source;
  return found.map((item) => source.slice(item.from, item.to));
}

describe("splitting one checker run back across the documents it came from", () => {
  it("reports nothing for a document the checker was happy with", () => {
    expect(diagnoseDocuments(docs(CLEAN)).get("cell-0")).toBeUndefined();
  });

  it("files a diagnostic under the document that actually contains it", () => {
    const documents = docs(CLEAN, BROKEN);
    const found = diagnoseDocuments(documents);

    expect(found.get("cell-0")).toBeUndefined();
    expect((found.get("cell-1") ?? []).length).toBeGreaterThan(0);
  });

  it("gives offsets local to that document, not into the combined text", () => {
    const documents = docs(CLEAN, BROKEN);
    const found = diagnoseDocuments(documents).get("cell-1") ?? [];

    for (const item of found) {
      expect(item.from).toBeGreaterThanOrEqual(0);
      expect(item.to).toBeLessThanOrEqual(BROKEN.length);
      expect(item.from).toBeLessThanOrEqual(item.to);
    }
  });

  it("lands the offset on real text of the document it belongs to", () => {
    const pointed = pointedAt(docs(CLEAN, BROKEN), "cell-1");

    expect(pointed.length).toBeGreaterThan(0);
    expect(pointed.every((text) => BROKEN.includes(text))).toBe(true);
  });

  it("points at the same text whichever position the document sits at", () => {
    const alone = pointedAt(docs(LATE), "cell-0");
    const third = pointedAt(docs(CLEAN, CLEAN, LATE), "cell-2");

    expect(alone).toEqual(['"s"']);
    expect(third).toEqual(alone);
  });

  it("offsets a later-line diagnostic from its own first line, not the combined one", () => {
    const shifted = diagnoseDocuments(docs(CLEAN, LATE)).get("cell-1") ?? [];

    expect(shifted.length).toBe(1);
    expect(LATE.slice(0, shifted[0]!.from)).toContain("x = add(");
    expect(shifted[0]!.from).toBeLessThan(LATE.length);
  });

  it("drops the trailing position from the message, since the range already says where", () => {
    const found = diagnoseDocuments(docs(BROKEN)).get("cell-0") ?? [];

    expect(found.length).toBeGreaterThan(0);
    for (const item of found) expect(item.message).not.toMatch(/ at \d+:\d+$/);
  });

  it("labels each diagnostic with a severity the linter understands", () => {
    const found = diagnoseDocuments(docs(BROKEN)).get("cell-0") ?? [];

    for (const item of found) expect(["error", "warning"]).toContain(item.severity);
  });

  it("survives a document that is empty, and one that is only blank lines", () => {
    expect(() => diagnoseDocuments(docs("", "\n\n", CLEAN))).not.toThrow();
  });

  it("answers an empty map when there is nothing to check at all", () => {
    expect([...diagnoseDocuments(docs()).keys()]).toEqual([]);
  });
});

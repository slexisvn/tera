import { describe, expect, it } from "vitest";
import { diffIR, summarize, type DiffRow } from "../src/services/ir-diff";

const BEFORE = `fn work params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1 preds=:
    v1 = Constant [value=3]
    v2 = Int32Add v0, v1
  B1 succs= preds=B0:
    v3 = Int32Mul v2, v2
    v4 = Return v3
}
`;

function kindsOf(rows: readonly DiffRow[]): Record<string, string> {
  const kinds: Record<string, string> = {};
  for (const row of rows) kinds[row.key] = row.kind;
  return kinds;
}

describe("diffing two printings of the same graph", () => {
  it("calls every line the same when nothing moved", () => {
    const rows = diffIR(BEFORE, BEFORE);

    expect(summarize(rows)).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
    expect(rows.every((row) => row.kind === "same")).toBe(true);
  });

  it("keys rows by value id, not by line position", () => {
    const reordered = BEFORE.replace(
      "    v1 = Constant [value=3]\n    v2 = Int32Add v0, v1\n",
      "    v2 = Int32Add v0, v1\n    v1 = Constant [value=3]\n",
    );
    const rows = diffIR(BEFORE, reordered);

    expect(summarize(rows)).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
  });

  it("reports a value the pass deleted as removed", () => {
    const after = BEFORE.replace("    v1 = Constant [value=3]\n", "");
    const rows = diffIR(BEFORE, after);

    expect(summarize(rows)).toMatchObject({ removed: 1, added: 0 });
    expect(kindsOf(rows).v1).toBe("removed");
  });

  it("reports a value the pass introduced as added", () => {
    const after = BEFORE.replace(
      "    v3 = Int32Mul v2, v2\n",
      "    v9 = Int32Shl v2, v2\n    v3 = Int32Mul v2, v2\n",
    );
    const rows = diffIR(BEFORE, after);

    expect(summarize(rows)).toMatchObject({ added: 1, removed: 0 });
    expect(kindsOf(rows).v9).toBe("added");
  });

  it("reports a rewritten value as changed and keeps the old text", () => {
    const after = BEFORE.replace("v2 = Int32Add v0, v1", "v2 = Int32Add v1, v0");
    const rows = diffIR(BEFORE, after);

    expect(summarize(rows)).toMatchObject({ changed: 1 });
    const changed = rows.find((row) => row.key === "v2")!;
    expect(changed.previous).toContain("Int32Add v0, v1");
  });

  it("reports a value hoisted into another block as moved, not as unchanged", () => {
    const hoisted = `fn work params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1 preds=:
    v1 = Constant [value=3]
    v2 = Int32Add v0, v1
    v3 = Int32Mul v2, v2
  B1 succs= preds=B0:
    v4 = Return v3
}
`;
    const rows = diffIR(BEFORE, hoisted);

    expect(summarize(rows)).toMatchObject({ moved: 1, changed: 0, added: 0, removed: 0 });
    const moved = rows.find((row) => row.key === "v3")!;
    expect(moved.kind).toBe("moved");
    expect(moved.movedFrom).toBe("B1");
  });

  it("treats the graph attribute line as its own row", () => {
    const withAttribute = BEFORE.replace("fn work params=1 {\n", "fn work params=1 {\n  graph [isAsync=true]\n");
    const rows = diffIR(BEFORE, withAttribute);

    expect(kindsOf(rows).graph).toBe("added");
  });

  it("shows every line as added when there was no previous printing", () => {
    const rows = diffIR("", BEFORE);

    expect(rows.every((row) => row.kind === "added")).toBe(true);
    expect(summarize(rows).added).toBe(rows.length);
  });
});

const MACHINE_BEFORE = `machine add:
.Ladd_0: -> .Ladd_1
  subq $8, %rsp
  movl %edi, %eax
  leal 0(%rax,%rsi,1), %eax
.Ladd_1:
  addq $8, %rsp
  ret
`;

describe("diffing two printings of a machine function", () => {
  it("keys instructions inside their own block, so an edit stays local", () => {
    const after = MACHINE_BEFORE.replace("  movl %edi, %eax\n", "");
    const rows = diffIR(MACHINE_BEFORE, after);

    expect(summarize(rows)).toMatchObject({ added: 0, changed: 1, removed: 1 });
  });

  it("does not report the second block as changed when only the first one shrank", () => {
    const after = MACHINE_BEFORE.replace("  subq $8, %rsp\n", "");
    const rows = diffIR(MACHINE_BEFORE, after);
    const epilogue = rows.filter((row) => row.key.startsWith(".Ladd_1#"));

    expect(epilogue.every((row) => row.kind === "same")).toBe(true);
  });

  it("keeps the machine function header as its own row", () => {
    const rows = diffIR(MACHINE_BEFORE, MACHINE_BEFORE.replace("machine add:", "machine sum:"));

    expect(rows.find((row) => row.key === "machine")!.kind).toBe("changed");
  });
});

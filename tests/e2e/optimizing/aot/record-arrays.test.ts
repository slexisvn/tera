import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, peAgrees } from "../../../helpers/aot-agreement.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

const ROW = "type Row = { name: string, hours: float }";

const WHOLE_AND_FRACTIONAL = src(
  ROW,
  'rows: Row[] = [{ name: "ada", hours: 41.5 }, { name: "grace", hours: 38.0 }]',
  "for row of rows:",
  "  print(row.name)",
);

const AGREEING: readonly (readonly [string, string])[] = [
  ["walks a record array whose float field is whole in one element", WHOLE_AND_FRACTIONAL],
  [
    "reads both fields of every element",
    src(
      ROW,
      'rows: Row[] = [{ name: "ada", hours: 41.5 }, { name: "grace", hours: 38.0 }]',
      "for row of rows:",
      "  print(row.name)",
      "  print(row.hours)",
    ),
  ],
  [
    "walks the same records with no type annotation",
    src(
      'rows = [{ name: "ada", hours: 41.5 }, { name: "grace", hours: 38.0 }]',
      "for row of rows:",
      "  print(row.hours)",
    ),
  ],
  [
    "widens when the whole-valued element comes first",
    src("rows = [{ h: 38.0 }, { h: 41.5 }]", "for r of rows:", "  print(r.h)"),
  ],
  [
    "widens across three elements that disagree",
    src("rows = [{ h: 1 }, { h: 2.5 }, { h: 3 }]", "for r of rows:", "  print(r.h)"),
  ],
  [
    "keeps a record array whose float field is whole throughout",
    src("rows = [{ h: 38.0 }, { h: 41.0 }]", "for r of rows:", "  print(r.h)"),
  ],
  [
    "keeps a record array whose fields are all ints",
    src("rows = [{ h: 1 }, { h: 2 }]", "for r of rows:", "  print(r.h)"),
  ],
  [
    "sums a widened field across the array",
    src(
      ROW,
      'rows: Row[] = [{ name: "ada", hours: 41.5 }, { name: "grace", hours: 38.0 }]',
      "total: float = 0.0",
      "for row of rows:",
      "  total = total + row.hours",
      "print(total)",
    ),
  ],
  [
    "indexes a record array whose float field is whole in one element",
    src(
      ROW,
      'rows: Row[] = [{ name: "ada", hours: 41.5 }, { name: "grace", hours: 38.0 }]',
      "print(rows[1].name)",
      "print(rows[1].hours)",
    ),
  ],
  [
    "builds a record array by pushing in a loop over another array",
    src(
      ROW,
      'names: string[] = ["ada", "grace"]',
      "rows: Row[] = []",
      "for n of names:",
      "  rows.push({ name: n, hours: 40.0 })",
      "for row of rows:",
      "  print(row.name)",
      "  print(row.hours)",
    ),
  ],
  [
    "builds a record array from elements it reads by index",
    src(
      'names: string[] = ["ada", "grace"]',
      "rows = []",
      "for i of range(0, 2):",
      "  rows.push({ n: names[i] })",
      "for r of rows:",
      "  print(r.n)",
    ),
  ],
  [
    "copies records field by field out of another record array",
    src(
      ROW,
      'src: Row[] = [{ name: "ada", hours: 41.5 }, { name: "grace", hours: 38.0 }]',
      "out: Row[] = []",
      "for row of src:",
      "  out.push({ name: row.name, hours: row.hours })",
      "for o of out:",
      "  print(o.name)",
      "  print(o.hours)",
    ),
  ],
  [
    "fills a record field from what a builtin method answers",
    src(
      'names: string[] = [" ada ", " grace "]',
      "rows = []",
      "for n of names:",
      "  rows.push({ name: n.trim().to_upper_case() })",
      "for r of rows:",
      "  print(r.name)",
    ),
  ],
  [
    "fills a record field from a builtin getter on the element",
    src(
      'names: string[] = ["ada", "grace"]',
      "rows = []",
      "for n of names:",
      "  rows.push({ name: n, size: n.length })",
      "for r of rows:",
      "  print(r.name)",
      "  print(r.size)",
    ),
  ],
  [
    "keeps only the records a test selects",
    src(
      ROW,
      'src: Row[] = [{ name: "ada", hours: 41.5 }, { name: "grace", hours: 38.0 }]',
      "busy: Row[] = []",
      "for row of src:",
      "  if row.hours > 40.0:",
      "    busy.push({ name: row.name, hours: row.hours })",
      "for b of busy:",
      "  print(b.name)",
    ),
  ],
  [
    "walks a record array whose text field is empty in one element",
    src(
      "type R = { name: string, note: string | null }",
      'rows: R[] = [{ name: "a", note: "hi" }, { name: "b", note: null }]',
      "for r of rows:",
      "  if r.note == null:",
      '    print(r.name + ": none")',
      "  else:",
      '    print(r.name + ": " + r.note)',
    ),
  ],
  [
    "walks a record array whose number field is empty in one element",
    src(
      "type R = { name: string, note: int | null }",
      'rows: R[] = [{ name: "a", note: 1 }, { name: "b", note: null }]',
      "for r of rows:",
      "  if r.note == null:",
      '    print(r.name + ": none")',
      "  else:",
      "    print(r.name)",
    ),
  ],
  [
    "keeps whole numbers a call answered in a record the loop pushes",
    src(
      "type Row = { name: string, score: int }",
      "fn parse(text: string) -> Row[]:",
      "  rows: Row[] = []",
      '  for line of text.split(";"):',
      '    parts = line.split(",")',
      "    if parts.length == 2:",
      "      rows.push({ name: parts[0], score: parse_int(parts[1]) })",
      "  return rows",
      'for row of parse("ada,90;grace,95;"):',
      '  print(row.name + " " + row.score.to_string())',
    ),
  ],
];

function declined(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`);
  return program.skipped.map((entry) => entry.reason).join("; ");
}

describe("AOT arrays of record literals", () => {
  for (const [what, source] of AGREEING) {
    itNative(`${what} (C)`, native.agrees(source));
    itRunsPe(`${what} (exe)`, () => peAgrees(source));
  }

  it("still refuses an array whose records disagree on a field's kind", () => {
    expect(
      declined(src('rows = [{ h: "a" }, { h: 2.5 }]', "for r of rows:", "  print(r.h)")),
    ).toContain("array literal has no element type");
  });
});

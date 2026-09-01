import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { peAgrees } from "../../../helpers/aot-agreement.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function compiled(source: string) {
  return nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
}

describe("AOT strings built across branches", () => {
  itRunsPe("appends a different piece per branch inside a loop", () => {
    peAgrees(
      src(
        "fn mask(n: int) -> string:",
        '  out = ""',
        "  for i of range(0, n):",
        "    if i % 2 == 0:",
        '      out = out + "#"',
        "    else:",
        '      out = out + "."',
        "  return out",
        "print(mask(7))",
      ),
    );
  });

  itRunsPe("builds an inner string per row and joins the rows", () => {
    peAgrees(
      src(
        "fn render(n: int) -> string:",
        '  out = ""',
        "  for i of range(0, n):",
        '    line = ""',
        "    for j of range(0, n):",
        "      if (i + j) % 2 == 0:",
        '        line = line + "#"',
        "      else:",
        '        line = line + "."',
        '    out = out + line + "\\n"',
        "  return out",
        "print(render(3))",
      ),
    );
  });

  itRunsPe("keeps two strings built in different branches apart", () => {
    peAgrees(
      src(
        "fn label(c: int) -> string:",
        '  a = "x" + c.to_string()',
        "  if c > 0:",
        "    s = a",
        "  else:",
        '    s = "y" + c.to_string()',
        "  print(a)",
        "  return s",
        "print(label(1))",
        "print(label(-1))",
      ),
    );
  });

  itRunsPe("declines to keep a string a later pass of the same loop overwrites", () => {
    expect(() =>
      compiled(
        src(
          "fn first(n: int) -> string:",
          '  held = ""',
          '  out = ""',
          "  for i of range(0, n):",
          "    if i == 0:",
          '      out = "row " + i.to_string()',
          "    else:",
          '      out = "row " + i.to_string() + "!"',
          "    if i == 0:",
          "      held = out",
          "  print(held)",
          "  return out",
          "print(first(3))",
        ),
      ),
    ).toThrow(/two strings into the same storage/);
  });
});

describe("AOT text joined through concat", () => {
  const JOINED: readonly (readonly [string, string])[] = [
    ["joins two pieces", src('a: string = "ab"', 'print(a.concat("cd"))')],
    ["joins three pieces in one call", src('a: string = "a"', 'print(a.concat("b", "c"))')],
    ["joins onto a literal receiver", src('print("ab".concat("cd"))')],
    [
      "joins a piece a call answered",
      src(
        "fn tail(n: int) -> string:",
        '  return "!" + n.to_string()',
        'a: string = "x"',
        "print(a.concat(tail(2)))",
      ),
    ],
    [
      "joins inside a loop",
      src(
        'out: string = ""',
        'for w of ["a", "b", "c"]:',
        "  out = out.concat(w)",
        "print(out)",
      ),
    ],
  ];

  for (const [what, source] of JOINED) {
    itRunsPe(what, () => peAgrees(source));
  }
});

describe("AOT text read out of a collection and then built on", () => {
  const ROWS = [
    "type Row = { name: string, qty: int }",
    'rows: Row[] = [{ name: "bolt", qty: 4 }, { name: "nut", qty: 12 }]',
  ];

  const BUILT: readonly (readonly [string, string])[] = [
    [
      "joins two produced strings inside a loop over records",
      src(...ROWS, "for r of rows:", '  print(r.name.pad_end(8, " ") + r.qty.to_string())'),
    ],
    [
      "joins a text field with a produced string",
      src(...ROWS, "for r of rows:", "  print(r.name + r.qty.to_string())"),
    ],
    [
      "joins after copying the fields into locals",
      src(
        ...ROWS,
        "for r of rows:",
        "  n: string = r.name",
        "  q: int = r.qty",
        '  print(n.pad_end(8, " ") + q.to_string())',
      ),
    ],
    [
      "joins through an index rather than a for-of",
      src(
        ...ROWS,
        "for i of range(0, 2):",
        '  print(rows[i].name.pad_end(8, " ") + rows[i].qty.to_string())',
      ),
    ],
    [
      "joins two produced strings over a text array",
      src(
        'names: string[] = ["bolt", "nut"]',
        "for n of names:",
        '  print(n.pad_end(8, " ") + n.length.to_string())',
      ),
    ],
    [
      "appends to a text element in a loop",
      src('names: string[] = ["a", "b"]', "for n of names:", '  print(n + "!")'),
    ],
  ];

  for (const [what, source] of BUILT) {
    itRunsPe(what, () => peAgrees(source));
  }
});

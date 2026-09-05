import { describe } from "vitest";
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

  itRunsPe("keeps a string a later pass of the same loop would overwrite", () => {
    peAgrees(
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
    );
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

describe("AOT strings carried through a loop from more than one source", () => {
  itRunsPe("wraps words into lines, taking the line from a word or from a join", () =>
    peAgrees(
      src(
        "fn wrap(words: string[], width: int) -> string[]:",
        "  lines: string[] = []",
        '  current: string = ""',
        "  for w of words:",
        "    if current.length == 0:",
        "      current = w",
        "    else:",
        "      if current.length + 1 + w.length > width:",
        "        lines.push(current)",
        "        current = w",
        "      else:",
        '        current = current + " " + w',
        "  if current.length > 0:",
        "    lines.push(current)",
        "  return lines",
        'for line of wrap(["aa", "bb", "cc", "dddddd", "e"], 5):',
        "  print(line)",
      ),
    ),
  );

  itRunsPe("keeps the carried string readable across enough rounds to collect", () =>
    peAgrees(
      src(
        'words: string[] = ["aa", "bb", "cc"]',
        'prev: string = ""',
        "out: string[] = []",
        "for i of range(0, 12000):",
        "  cur: string = words[i % 3]",
        "  if i % 2 == 0:",
        '    cur = words[i % 3] + "x"',
        "  spare: int[] = [i]",
        "  if spare[0] >= 0:",
        "    out.push(prev)",
        "  prev = cur",
        "print(out.length)",
        "print(out[11999])",
        "print(prev)",
      ),
    ),
  );
});

describe("a string read from a field kept alongside one that is built", () => {
  itRunsPe("formats a number in the same statement that reads a field", () => {
    peAgrees(
      src(
        "type Line = { item: string, qty: int, unit: float }",
        "fn money(v: float) -> string:",
        '  return "$" + v.to_fixed(2)',
        "lines: Line[] = [",
        '  { item: "keyboard", qty: 2, unit: 49.99 },',
        '  { item: "cable", qty: 4, unit: 7.25 },',
        "]",
        "total = 0.0",
        "for l of lines:",
        "  s = l.unit * l.qty",
        "  total += s",
        '  print(l.item, "x", l.qty, "=", money(s))',
        'print("total:", money(total))',
      ),
    );
  });

  itRunsPe("reads one field while another field of the same object is written", () => {
    peAgrees(
      src(
        "class Banner:",
        "  public constructor(text: string):",
        '    this.name = "banner"',
        "    this.text = text",
        "  public render(width: int) -> string:",
        "    pad = width - this.text.length",
        "    if pad < 0:",
        "      pad = 0",
        '    return "[" + this.text + " ".repeat(pad) + "]"',
        "fn show(r: Banner, width: int):",
        '  print(r.name, "->", r.render(width))',
        'for it of [Banner("hello"), Banner("tera")]:',
        "  show(it, 10)",
      ),
    );
  });

  itRunsPe("keeps a field string in an array when nothing ever rewrites that field", () => {
    peAgrees(
      src(
        "type Edge = { src: string, to: string }",
        "edges: Edge[] = [",
        '  { src: "a", to: "b" },',
        '  { src: "a", to: "c" },',
        '  { src: "b", to: "d" },',
        "]",
        "fn neighbours(node: string) -> string[]:",
        "  out: string[] = []",
        "  for e of edges:",
        "    if e.src == node:",
        "      out.push(e.to)",
        "  return out",
        'print(neighbours("a").join(","))',
        'print(neighbours("b").join(","))',
        'print(neighbours("z").length)',
      ),
    );
  });

  itRunsPe("carries an awaited string into a second await", () => {
    peAgrees(
      src(
        "async fn name_of(id: int) -> string:",
        "  await sleep(1)",
        "  return `user-${id}`",
        "async fn score(n: string) -> int:",
        "  await sleep(1)",
        "  return n.length",
        "async fn main():",
        "  for id of [1, 2]:",
        "    n = await name_of(id)",
        "    s = await score(n)",
        '    print(n, "scored", s)',
        "main()",
      ),
    );
  });
});

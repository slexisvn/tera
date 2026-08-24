import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

function project(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tera-json-parse-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "main.tera"), source, "utf8");
  return root;
}

function compiled(source: string, backend = "x64-windows") {
  const root = project(source);
  return nodeEngine({ typecheck: "off" }).compileAotModule(path.join(root, "main.tera"), {
    root,
    wholeProgram: true,
    backend,
    format: backend === "c" ? "assembly" : "executable",
  });
}

function image(source: string): Uint8Array {
  const program = compiled(source);
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(source);
  return stream.join("");
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function skipReasons(source: string, backend = "c"): string {
  try {
    return compiled(source, backend)
      .skipped.map((entry) => entry.reason)
      .join("; ");
  } catch (error) {
    return (error as Error).message;
  }
}

const DOC = "type Doc = { title: string, size: float, live: bool, tags: string[], counts: int[] }";
const SHOW = [
  "fn show(d: Doc) -> void:",
  `  print(d.title, d.size, d.live, d.tags.join("|"), d.counts.join("|"))`,
];

function spelled(json: string): string {
  return json.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function reads(json: string): string {
  return src(DOC, ...SHOW, `d: Doc = JSON.parse("${spelled(json)}")`, "show(d)");
}

const POINT = "type Point = { x: int, y: int }";

const HELD = [POINT, "type Held = { at: Point, tag: string }"];
const HOLDS = ["fn hold(h: Held) -> void:", "  print(h.at.x, h.at.y, h.tag)"];

function holds(json: string): string {
  return src(...HELD, ...HOLDS, `h: Held = JSON.parse("${spelled(json)}")`, "hold(h)");
}

const SCENE = [
  POINT,
  "type Box = { lo: Point, hi: Point }",
  "type Scene = { area: Box, marks: int[] }",
];
const FRAMES = [
  "fn frame(s: Scene) -> void:",
  `  print(s.area.lo.x, s.area.lo.y, s.area.hi.x, s.area.hi.y, s.marks.join("|"))`,
];

function frames(json: string): string {
  return src(...SCENE, ...FRAMES, `s: Scene = JSON.parse("${spelled(json)}")`, "frame(s)");
}

const PATH = [POINT, "type Path = { pts: Point[], name: string }"];
const WALKS = [
  "fn walk(p: Path) -> void:",
  "  total: int = 0",
  "  at: int = 0",
  "  while at < p.pts.length:",
  "    total = total + p.pts[at].x * p.pts[at].y",
  "    at = at + 1",
  "  print(p.name, p.pts.length, total)",
];

function walks(json: string): string {
  return src(...PATH, ...WALKS, `p: Path = JSON.parse("${spelled(json)}")`, "walk(p)");
}

const COMPLETE = String.raw`{"title": "one", "size": 2.5, "live": true, "tags": ["a","b"], "counts": [1,2,3]}`;
const SPACED = String.raw`  {  "title" : "two" , "size" : 0.5 , "live" : false , "tags" : [ ] , "counts" : [ 7 , 8 ] }  `;
const REORDERED = String.raw`{"counts": [], "tags": ["z"], "live": true, "size": -1.5e2, "title": "three"}`;
const EXTRA_KEYS = String.raw`{"note": {"deep": [1, {"x": "y"}]}, "title": "four", "size": 1.0, "live": false, "tags": [], "counts": [], "trailing": null}`;
const ESCAPED = String.raw`{"title": "a\nb\t\"c\"\\d\u0041\/e", "size": 0.0, "live": true, "tags": ["p\tq"], "counts": []}`;
const NEGATIVE = String.raw`{"title": "", "size": -0.25, "live": false, "tags": [], "counts": [-4, 0, 12]}`;

const NESTED = String.raw`{"at": {"x": 3, "y": -4}, "tag": "here"}`;
const NESTED_LAST = String.raw`{"tag": "there", "at": {"y": 7, "x": 8}}`;
const NESTED_EXTRA = String.raw`{"at": {"x": 1, "z": [{"q": 0}], "y": 2}, "note": "skip", "tag": "t"}`;
const TWO_DEEP = String.raw`{"area": {"lo": {"x": 1, "y": 2}, "hi": {"x": 3, "y": 4}}, "marks": [5, 6]}`;
const SHAPE_LIST = String.raw`{"pts": [{"x": 2, "y": 3}, {"x": 4, "y": 5}], "name": "p"}`;
const EMPTY_LIST = String.raw`{"name": "none", "pts": []}`;

describe("AOT JSON.parse", () => {
  it("compiles a program that reads JSON into a declared shape", () => {
    expect(compiled(reads(COMPLETE), "c").skipped).toEqual([]);
  });

  itRunsPe("reads every field the way the interpreter does", () => {
    agrees(reads(COMPLETE));
  });

  itRunsPe("ignores the whitespace between tokens", () => {
    agrees(reads(SPACED));
  });

  itRunsPe("takes the fields in any order", () => {
    agrees(reads(REORDERED));
  });

  itRunsPe("walks past keys the shape does not name", () => {
    agrees(reads(EXTRA_KEYS));
  });

  itRunsPe("unescapes the escapes JSON spells", () => {
    agrees(reads(ESCAPED));
  });

  itRunsPe("reads negative and exponent numbers", () => {
    agrees(reads(NEGATIVE));
  });

  itRunsPe("answers the type's zero for a key the text leaves out", () => {
    const run = runPe(image(reads("{}")));

    expect([run.status, run.stdout]).toEqual([0, " 0 false  \n"]);
  });

  itRunsPe("stops on text that is not JSON", () => {
    const run = runPe(image(reads("{oops}")));

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("invalid JSON at position");
  });

  itRunsPe("stops on a document with something after it", () => {
    const run = runPe(image(reads(String.raw`{"title": "x"} tail`)));

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("invalid JSON at position");
  });

  itRunsPe("reads JSON handed to a declared parameter", () => {
    const run = runPe(
      image(
        src(
          "type Pair = { a: int, b: int }",
          "fn total(p: Pair) -> int:",
          "  return p.a + p.b",
          `print(total(JSON.parse("{\\"a\\": 4, \\"b\\": 5}")))`,
        ),
      ),
    );

    expect([run.status, run.stdout]).toEqual([0, "9\n"]);
  });

  itRunsPe("reads JSON a function answers", () => {
    const run = runPe(
      image(
        src(
          "type Pair = { a: int, b: int }",
          "fn read(text: string) -> Pair:",
          "  return JSON.parse(text)",
          `print(read("{\\"a\\": 1, \\"b\\": 2}").b)`,
        ),
      ),
    );

    expect([run.status, run.stdout]).toEqual([0, "2\n"]);
  });

  it("declines JSON with no declared shape to read it into", () => {
    expect(skipReasons(src(`o = JSON.parse("{}")`, "print(1)"))).toContain(
      "a value whose shape is only known once the text is read",
    );
  });

  it("compiles a shape whose field is another declared shape", () => {
    expect(compiled(holds(NESTED), "c").skipped).toEqual([]);
  });

  itRunsPe("reads a field whose type is another declared shape", () => {
    agrees(holds(NESTED));
  });

  itRunsPe("takes a nested object in any position", () => {
    agrees(holds(NESTED_LAST));
  });

  itRunsPe("walks past keys the nested shape does not name", () => {
    agrees(holds(NESTED_EXTRA));
  });

  itRunsPe("reads a shape nested two deep", () => {
    agrees(frames(TWO_DEEP));
  });

  itRunsPe("reads an array whose element is a declared shape", () => {
    agrees(walks(SHAPE_LIST));
  });

  itRunsPe("reads an empty array of a declared shape", () => {
    agrees(walks(EMPTY_LIST));
  });

  itRunsPe("answers the nested shape's zeros for an object the text leaves out", () => {
    const run = runPe(image(src(...HELD, ...HOLDS, `h: Held = JSON.parse("{}")`, "hold(h)")));

    expect([run.status, run.stdout]).toEqual([0, "0 0 \n"]);
  });

  it("declines a shape that holds itself", () => {
    expect(
      skipReasons(
        src(
          "type Chain = { next: Chain, v: int }",
          `c: Chain = JSON.parse("{}")`,
          "print(c.v)",
        ),
      ),
    ).toContain("a value whose shape is only known once the text is read");
  });

  it("leaves the interpreter reading JSON its own way", () => {
    expect(interpreted(reads(COMPLETE))).toBe("one 2.5 true a|b 1|2|3\n");
  });
});

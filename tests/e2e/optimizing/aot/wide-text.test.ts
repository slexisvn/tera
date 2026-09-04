import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";
import { itNative } from "../../../helpers/c-executor.js";
import { cAgreement, peAgrees } from "../../../helpers/aot-agreement.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";

const src = (...lines: string[]) => lines.join("\n");

const native = cAgreement();

function refusal(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "assembly",
  });
  return program.skipped.map((one) => one.reason).join(" | ");
}

const AGREEING: readonly (readonly [string, string])[] = [
  ["prints text outside ASCII", 'print("Xin chào thế giới")'],
  ["prints an emoji", 'print("done ✅")'],
  ["interpolates a name into it", src('name = "Sinh"', "print(`Chào ${name}`)")],
  ["joins it onto ASCII", src('greeting = "Chào" + " " + "bạn"', "print(greeting)")],
  [
    "keeps it in an array and reads it back",
    src('cities: string[] = ["Hà Nội", "Huế", "Đà Nẵng"]', "for c of cities:", "  print(c)"),
  ],
  [
    "joins an array of it",
    src('cities: string[] = ["Hà Nội", "Huế"]', 'print(cities.join(" - "))'),
  ],
  [
    "counts the elements rather than the characters",
    src('cities: string[] = ["Hà Nội", "Huế"]', "print(cities.length)"),
  ],
  [
    "keeps it in a record field",
    src(
      "type Person = { name: string, city: string }",
      'people: Person[] = [{ name: "Trần Thị B", city: "Huế" }]',
      "for p of people:",
      "  print(`${p.name} — ${p.city}`)",
    ),
  ],
  [
    "keeps it in a class field",
    src(
      "class Greeter:",
      "  public constructor(name: string):",
      "    this.name = name",
      "  public greet() -> string:",
      "    return `Xin chào, ${this.name}!`",
      'print(Greeter("Sinh").greet())',
    ),
  ],
  ["compares it for sameness", src('a = "Huế"', 'b = "Huế"', 'c = "Hà Nội"', "print(a == b, a == c)")],
  ["searches it for a substring", src('c = "Hà Nội"', 'print(c.includes("Nội"))')],
  ["tests a prefix and a suffix of it", src('c = "Hà Nội"', 'print(c.starts_with("Hà"), c.ends_with("ội"))')],
  ["replaces inside it", src('c = "Hà Nội"', 'print(c.replace("Hà", "Ha"))')],
  ["repeats it", 'print("═".repeat(4))'],
  [
    "splits it on a separator inside ASCII",
    src('line = "Hà Nội,Huế,Đà Nẵng"', 'for p of line.split(","):', "  print(p)"),
  ],
  [
    "splits it on a separator inside ASCII keeping only some pieces",
    src('line = "Hà Nội,Huế,Đà Nẵng"', 'for p of line.split(",", 2):', "  print(p)"),
  ],
  [
    "still counts the characters of text that stayed inside ASCII",
    src('print("Chào bạn")', 'code = "abc-def"', "print(code.length, code.index_of(\"-\"))"),
  ],
  [
    "formats a report in it",
    src(
      "type Row = { ten: string, gia: float }",
      'rows: Row[] = [{ ten: "Cà phê", gia: 45000.0 }, { ten: "Bánh mì", gia: 20000.0 }]',
      "tong = 0.0",
      "for r of rows:",
      "  tong += r.gia",
      "  print(`${r.ten}: ${r.gia.to_fixed(0)}`)",
      "print(`Tổng: ${tong.to_fixed(0)} đồng`)",
    ),
  ],
];

const REFUSED: readonly (readonly [string, string, string])[] = [
  [
    "counting the characters of text outside ASCII",
    src('c = "Hà Nội"', "print(c.length)"),
    "string.length counts characters",
  ],
  [
    "taking a character out of it by position",
    src('c = "Huế"', "print(c.char_at(1))"),
    "string.char_at counts characters",
  ],
  [
    "slicing it by position",
    src('c = "Huế"', "print(c.slice(0, 2))"),
    "string.slice counts characters",
  ],
  [
    "asking where a substring sits inside it",
    src('c = "Hà Nội"', 'print(c.index_of("Nội"))'),
    "string.index_of counts characters",
  ],
  [
    "changing its case",
    src('c = "Huế"', "print(c.to_upper_case())"),
    "string.to_upper_case counts characters",
  ],
  [
    "trimming it",
    src('c = "  Huế  "', "print(c.trim())"),
    "string.trim counts characters",
  ],
  [
    "padding it to a width",
    src('c = "Huế"', 'print(c.pad_start(8, "."))'),
    "string.pad_start counts characters",
  ],
  [
    "splitting it into single characters",
    src('for ch of "Hà".split(""):', "  print(ch)"),
    "counts characters",
  ],
  [
    "splitting on a separator outside ASCII",
    src('for p of "aộb".split("ộ"):', "  print(p)"),
    "split compiles when its separator is one spelled-out character",
  ],
  [
    "splitting on a separator outside ASCII with a count of pieces",
    src('for p of "aộb".split("ộ", 2):', "  print(p)"),
    "split compiles when its separator is one spelled-out character",
  ],
  [
    "splitting it into a counted run of single characters",
    src('for ch of "Hà".split("", 2):', "  print(ch)"),
    "counts characters",
  ],
  [
    "ordering it against other text",
    src('a = "Huế"', 'b = "Hà"', "print(a < b)"),
    "ordering text with < counts characters",
  ],
  [
    "asking where a substring last sits inside it",
    src('c = "Hà Nội Hà"', 'print(c.last_index_of("Hà"))'),
    "string.length counts characters",
  ],
  [
    "counting the characters of a line the program read",
    src('name = input("? ")', "print(name.length)"),
    "string.length counts characters",
  ],
  [
    "indexing into a line the program read",
    src('name = input("? ")', "print(name.char_at(0))"),
    "string.char_at counts characters",
  ],
  [
    "measuring text a function was handed once some escaped the module",
    src(
      "fn measure(s: string) -> int:",
      "  return s.length",
      'cities: string[] = ["Hà Nội"]',
      "for c of cities:",
      "  print(measure(c))",
    ),
    "string.length counts characters",
  ],
];

describe("text outside ASCII compiled ahead of time", () => {
  for (const [name, source] of AGREEING) {
    itRunsPe(`${name} the way the interpreter does`, () => peAgrees(source));
    itNative(`${name} the same way through the C backend`, native.agrees(source));
  }
});

describe("what a compiled program refuses to do with text outside ASCII", () => {
  for (const [name, source, reason] of REFUSED) {
    it(`refuses ${name}, saying why`, () => {
      expect(refusal(source)).toContain(reason);
    });
  }

  it("still does with a line it read what the encoding does not change", () => {
    expect(
      refusal(
        src(
          'name = input("? ")',
          "print(`Chào ${name}`)",
          'print(name.includes("a"), name == "Huế", name.starts_with("H"))',
        ),
      ),
    ).toBe("");
  });

  it("still counts the characters of ASCII text in a program that also holds wide text", () => {
    expect(refusal(src('print("Chào")', 'code = "ab"', "print(code.length)"))).toBe("");
  });

  it("measures a constant against the bytes it takes, not the characters", () => {
    const wide = "é".repeat(200);
    const program = nodeEngine({ typecheck: "off" }).compileAot(`print("${wide}")\n`, {
      backend: "x64-windows",
      format: "assembly",
      compilerOptions: compilerOptions("speed", { textBufferBytes: 256 }),
    });
    expect(program.skipped.map((one) => one.reason).join(" | ")).toContain(
      "bytes a compiled string holds",
    );
  });
});

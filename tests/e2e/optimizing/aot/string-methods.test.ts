import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { cCalls, cText } from "../../../helpers/aot-agreement.js";
import { TEXT_STORAGE_BYTES } from "../../../../src/optimizing/types/scalar.js";
import { compilerOptions } from "../../../../src/optimizing/options.js";

const KEEPS_CALLS = compilerOptions("speed", { inlineBudget: 0 });

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(
    `${source}\n`,
  );
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

const returns = cCalls({
  toC: (body: string) => cText(src("fn f() -> string:", `  return ${body}`)),
});

const TEXT_RESULTS: readonly (readonly [string, string])[] = [
  ['"aBc".to_upper_case()', "ABC"],
  ['"aBc".to_lower_case()', "abc"],
  ['"  ab  ".trim()', "ab"],
  ['"  ab  ".trim_start()', "ab  "],
  ['"  ab  ".trim_end()', "  ab"],
  ['"abcdef".slice(1, 3)', "bc"],
  ['"abcdef".slice(2)', "cdef"],
  ['"ab".repeat(3)', "ababab"],
  ['"a-b-c".replace("-", "+")', "a+b-c"],
  ['"a-b-c".replace_all("-", "+")', "a+b+c"],
];


const AGREEING_PROGRAMS: readonly (readonly [string, string])[] = [
  ["upper-cases ascii", 'print("aBc 1!".to_upper_case())'],
  ["lower-cases ascii", 'print("AbC 1!".to_lower_case())'],
  ["trims both ends", 'print("[" + "  ab  ".trim() + "]")'],
  ["trims the leading end", 'print("[" + "  ab  ".trim_start() + "]")'],
  ["trims the trailing end", 'print("[" + "  ab  ".trim_end() + "]")'],
  ["trims a string that is all blanks", 'print("[" + "   ".trim() + "]")'],
  ["slices a range", 'print("abcdef".slice(1, 3))'],
  ["slices to the end when the end is omitted", 'print("abcdef".slice(2))'],
  ["slices from a negative start", 'print("abcdef".slice(-2))'],
  ["slices to a negative end", 'print("abcdef".slice(1, -1))'],
  ["slices an inverted range to nothing", 'print("[" + "abc".slice(2, 1) + "]")'],
  ["slices past the end", 'print("abc".slice(1, 99))'],
  ["repeats a string", 'print("ab".repeat(3))'],
  ["repeats zero times", 'print("[" + "ab".repeat(0) + "]")'],
  ["replaces the first match only", 'print("a-b-c".replace("-", "+"))'],
  ["replaces every match", 'print("a-b-c".replace_all("-", "+"))'],
  ["replaces nothing when there is no match", 'print("abc".replace("z", "+"))'],
  ["replaces with a longer string", 'print("aXa".replace_all("X", "YYY"))'],
  ["replaces with an empty string", 'print("XXab".replace_all("X", ""))'],
  ["replaces overlapping-looking matches left to right", 'print("the cat sat".replace_all("at", "og"))'],
  ["finds a substring", 'print("abcd".index_of("cd"))'],
  ["reports a missing substring as -1", 'print("abcd".index_of("zz"))'],
  ["finds the first of several matches", 'print("abab".index_of("ab"))'],
  ["finds the empty substring at zero", 'print("abcd".index_of(""))'],
  ["tells that a substring is present", 'print("abcd".includes("bc"))'],
  ["tells that a substring is absent", 'print("abcd".includes("zz"))'],
  ["tests a prefix", 'print("abcd".starts_with("ab"))'],
  ["rejects a non-prefix", 'print("abcd".starts_with("bc"))'],
  ["tests a suffix", 'print("abcd".ends_with("cd"))'],
  ["rejects a non-suffix", 'print("abcd".ends_with("ab"))'],
  ["rejects a suffix longer than the string", 'print("ab".ends_with("xxxx"))'],
  [
    "chains several methods on a constant",
    'print("  Hello World  ".trim().to_upper_case().slice(0, 5))',
  ],
  [
    "chains several methods on a variable",
    src('raw = "  Hello World  "', "print(raw.trim().to_upper_case().slice(0, 5))"),
  ],
  [
    "chains a method onto a method that returns int",
    src('raw = "  hello  "', "print(raw.trim().index_of(\"ll\"))"),
  ],
  [
    "calls a method on a built string",
    src("name = \"bob\"", 'print(("hi " + name).to_upper_case())'),
  ],
  [
    "calls a method in a loop",
    src('word = "hey"', "for i of range(0, 2):", "  print(word.to_upper_case())"),
  ],
  [
    "passes a range loop variable to int-argument methods",
    src(
      "for i of range(0, 3):",
      '  print(i, "ab".repeat(i), "cd".slice(0, i))',
    ),
  ],
  [
    "calls a method on a parameter",
    src(
      "fn shout(word: string) -> string:",
      "  return word.to_upper_case()",
      'print(shout("hey"))',
    ),
  ],
  [
    "calls a method on a string held in a field",
    src(
      "class P:",
      "  public constructor(n: string):",
      "    this.n = n",
      'print(P("bob").n.to_upper_case())',
    ),
  ],
  [
    "reads the length of a string held in a field",
    src(
      "class P:",
      "  public constructor(n: string):",
      "    this.n = n",
      'print(P("bob").n.length)',
    ),
  ],
  [
    "calls a method on a string a field was declared with",
    src(
      "class P:",
      '  public n: string = "bob"',
      "  public constructor():",
      "    this.v = 1",
      "print(P().n.to_upper_case())",
    ),
  ],
  [
    "calls a method on the string a function returned",
    src("fn name() -> string:", '  return "bob"', "print(name().to_upper_case())"),
  ],
  [
    "reads the length of the string a function returned",
    src("fn name() -> string:", '  return "bob"', "print(name().length)"),
  ],
  [
    "chains methods on the string a function returned",
    src("fn name() -> string:", '  return "  Bob  "', "print(name().trim().to_lower_case())"),
  ],
  ["indexes a literal", 'print("abc"[0], "abc"[2])'],
  [
    "indexes a string in a loop",
    src('s = "abc"', "i: int = 0", "while i < s.length:", "  print(s[i])", "  i = i + 1"),
  ],
  [
    "indexes a string held in a field",
    src(
      "class P:",
      "  public constructor(n: string):",
      "    this.n = n",
      'print(P("bob").n[1])',
    ),
  ],
  [
    "indexes a parameter",
    src("fn first(s: string) -> string:", "  return s[0]", 'print(first("xyz"))'),
  ],
  ["compares an indexed character", src('s = "abc"', 'print(s[0] == "a", s[1] == "a")')],
];

describe("string methods as compiled builtins", () => {
  itRunsPe("holds two strings the same function built", () => {
    agrees(src("fn s(n: int) -> string:", '  return "x" + n', "print(s(1), s(2))"));
  });

  itRunsPe("collects strings a method built into an array", () => {
    agrees(
      src(
        "class L:",
        "  public name: string",
        "  public constructor(name: string):",
        "    this.name = name",
        "  public update(v: string) -> string:",
        '    return this.name + ":" + v',
        "fn notify(ls: L[], v: string) -> string:",
        "  out = []",
        "  for l of ls:",
        "    out.push(l.update(v))",
        '  return out.join(",")',
        'print(notify([L("a"), L("b")], "ready"))',
      ),
    );
  });

  for (const [name, source] of AGREEING_PROGRAMS) {
    itRunsPe(`${name} the way the interpreter does`, () => agrees(source));
  }

  itNative("routes each method through its own C helper", () => {
    const program = nodeEngine({ typecheck: "off" }).compileAot(
      src(
        "fn f(s: string) -> string:",
        "  return s.trim().to_upper_case().to_lower_case().slice(0, 4).repeat(2).replace(\"a\", \"b\")",
        "",
      ),
    );

    expect(program.skipped).toEqual([]);
    for (const helper of [
      "tera_string_trim(",
      "tera_string_upper(",
      "tera_string_lower(",
      "tera_string_slice(",
      "tera_string_repeat(",
      "tera_string_replace(",
    ]) {
      expect(cSource(program)).toContain(helper);
    }
  });

  for (const [body, expected] of TEXT_RESULTS) {
    itNative(`keeps the C backend in lockstep on ${body}`, returns.text(body, "f", [], expected));
  }

  itRunsPe("truncates at the buffer capacity instead of overrunning it", () => {
    const run = runPe(image(src('print("ab".repeat(100000).length)')));

    expect(run.status).toBe(0);
    expect(Number(run.stdout.trim())).toBe(TEXT_STORAGE_BYTES - 1);
  });

  it("compiles a split whose separator reaches the call site as a literal", () => {
    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(
        src(
          "fn parts(s: string, sep: string) -> int:",
          "  return s.split(sep).length",
          'print(parts("a,b", ","))',
          "",
        ),
        { backend: "x64-windows", format: "executable" },
      ),
    ).not.toThrow();
  });

  it("declines a split whose separator is not one spelled-out character", () => {
    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(
        src(
          "fn parts(s: string, sep: string) -> int:",
          "  if sep.length == 0:",
          "    return 0",
          "  return s.split(sep).length",
          'print(parts("a,b", ","))',
          "",
        ),
        {
          backend: "x64-windows",
          format: "executable",
          compilerOptions: KEEPS_CALLS,
        },
      ),
    ).toThrow(/split/);
  });
  itRunsPe("splits on a spelled-out separator the way the interpreter does", () => {
    agrees(
      src(
        "fn show(parts: string[]):",
        "  print(parts.length)",
        '  print(parts.join("|"))',
        'show("a,b,c".split(","))',
        'show(",lead".split(","))',
        'show("trail,".split(","))',
        'show("".split(","))',
        'show("no-sep".split(","))',
        'show("a,,b".split(","))',
        'show("x y z".split(" "))',
      ),
    );
  });

  itRunsPe("walks the pieces a split answers", () => {
    agrees(
      src(
        'for piece of "one,two,three".split(","):',
        "  print(piece.to_upper_case())",
      ),
    );
  });
  itRunsPe("splits into characters when the separator is empty", () => {
    agrees(
      src(
        'print("racecar".split("").reverse().join(""))',
        'print("abc".split("").length)',
        'print("".split("").length)',
      ),
    );
  });
});

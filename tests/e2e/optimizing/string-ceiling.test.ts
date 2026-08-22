import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import { hostBackendId } from "../../../src/optimizing/backends/index.js";

const HOST_TARGET = hostBackendId()!;

const src = (...lines: string[]) => lines.join("\n");

const engine = nodeEngine({ typecheck: "off" });

function reasons(source: string): { x64: string; c: string } {
  const x64 = engine.compileAot(source, { backend: HOST_TARGET });
  const c = engine.compileAot(source);
  return {
    x64: x64.skipped.map((fn) => fn.reason).join("; "),
    c: c.skipped.map((fn) => fn.reason).join("; "),
  };
}

function bothDecline(source: string, expected: string): void {
  const { x64, c } = reasons(source);
  expect(x64).toContain(expected);
  expect(c).toContain(expected);
}

function bothRefuse(source: string, expected: string): void {
  expect(() => reasons(source)).toThrow(expected);
}

function bothAdmit(source: string): void {
  const { x64, c } = reasons(source);
  expect(x64).toBe("");
  expect(c).toBe("");
}

describe("the AOT string ceiling", () => {
  it("admits concatenation, rendering and indexing of strings", () => {
    bothAdmit(
      src(
        "fn render(n: int, s: string) -> string:",
        '  return n.to_string() + s.char_at(0) + "!"',
      ),
    );
  });

  it("renders a number added to a string through to_string coercion", () => {
    bothAdmit(src("fn f(s: string, n: int) -> string:", "  return s + n"));
    bothAdmit(src("fn f(s: string, n: int) -> string:", "  return n + s"));
  });

  it("renders a float as decimal text", () => {
    bothAdmit(src("fn f(x: float) -> string:", "  return x.to_string()"));
    bothAdmit(src("fn f(x: float) -> string:", "  return `v=${x}`"));
  });

  it("declines to_string with an explicit radix", () => {
    bothDecline(
      src("fn f(n: int) -> string:", "  return n.to_string(16)"),
      "int.to_string has an unsupported argument count",
    );
  });

  it("admits an array of spelled-out strings because they live in read-only data", () => {
    bothAdmit(src("fn f(i: int) -> string:", '  names = ["H", "O"]', "  return names[i]"));
  });

  it("admits an array of strings the program builds, because elements hold text", () => {
    bothAdmit(
      src(
        "fn f(i: int, s: string) -> string:",
        '  names = ["H", "O"]',
        '  names[i] = s + "!"',
        "  return names[i]",
      ),
    );
  });

  it("refuses storing a string into a numeric array", () => {
    bothRefuse(
      src("fn f(i: int) -> string:", "  cells = [0, 0]", '  cells[i] = "H"', "  return cells[i]"),
      "Type 'string' is not assignable to 'int'",
    );
  });

  it("declines prepending an accumulator to itself", () => {
    bothDecline(
      src(
        "fn f(n: int) -> string:",
        '  out = ""',
        "  i = 0",
        "  while i < n:",
        '    out = "ab" + out',
        "    i = i + 1",
        "  return out",
      ),
      "string buffer is used as a trailing operand of its own producer",
    );
  });

  it("admits building a string after a call has already returned", () => {
    bothAdmit(
      src(
        "fn tag(n: int) -> int:",
        "  return n + 1",
        "fn f(n: int, s: string) -> string:",
        "  if tag(n) > 2:",
        '    return s + "!"',
        "  return s",
      ),
    );
  });

  it("keeps a string buffer live across a call the callee cannot re-enter", () => {
    bothAdmit(
      src(
        "fn tag(n: int) -> int:",
        "  return n + 1",
        "fn f(n: int, s: string) -> string:",
        '  built = s + "!"',
        "  if tag(n) > 2:",
        "    return built",
        "  return s",
      ),
    );
  });

  it("admits string building in a function that can re-enter itself", () => {
    bothAdmit(
      src(
        "fn tag(n: int) -> string:",
        "  if n <= 0:",
        '    return "."',
        '  return "x" + tag(n - 1)',
      ),
    );
  });

  it("declines a string it built that is held across a call that can re-enter", () => {
    bothDecline(
      src(
        "fn tag(n: int) -> string:",
        '  out = ""',
        "  for i of range(0, n):",
        '    out = out + "x"',
        "  if n > 0:",
        "    tag(n - 1)",
        "  return out",
      ),
      "tag keeps the string it built across a call to tag",
    );
  });

  it("keeps admitting a numeric function that calls another function", () => {
    bothAdmit(
      src("fn tag(n: int) -> int:", "  return n + 1", "fn f(n: int) -> int:", "  return tag(n) * 2"),
    );
  });

  it("admits a line of input copied into a field the object owns", () => {
    bothAdmit(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "fn read() -> P:",
        "  return P(input())",
      ),
    );
  });

  it("admits a built string copied into a field the object owns", () => {
    bothAdmit(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "fn make(i: int) -> P:",
        '  return P("v" + i.to_string())',
      ),
    );
  });

  it("admits reading a line in a function that can re-enter itself", () => {
    bothAdmit(
      src(
        "fn read(n: int) -> int:",
        "  a = input()",
        "  if n > 0:",
        "    return read(n - 1)",
        "  print(a)",
        "  return 0",
      ),
    );
  });

  it("keeps two returned strings alive at once by copying each into storage of its own", () => {
    bothAdmit(
      src(
        "fn build(n: int) -> string:",
        '  return "v" + n.to_string()',
        "fn f(n: int) -> int:",
        "  a = build(n)",
        "  b = build(n + 1)",
        "  print(a)",
        "  print(b)",
        "  return 0",
      ),
    );
  });

  it("admits a returned string used before the call that rebuilds it", () => {
    bothAdmit(
      src(
        "fn build(n: int) -> string:",
        '  return "v" + n.to_string()',
        "fn f(n: int) -> int:",
        "  print(build(n))",
        "  print(build(n + 1))",
        "  return 0",
      ),
    );
  });

  it("keeps a string a wrapper returned across a call that rebuilds the buffer behind it", () => {
    bothAdmit(
      src(
        "fn build(n: int) -> string:",
        '  return "v" + n.to_string()',
        "fn wrap(n: int) -> string:",
        "  return build(n)",
        "fn f(n: int) -> int:",
        "  a = wrap(n)",
        "  print(build(n + 1))",
        "  print(a)",
        "  return 0",
      ),
    );
  });

  it("declines keeping a string read from a field across a write to that field", () => {
    bothDecline(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "fn f(p: P) -> int:",
        "  s = p.n",
        '  p.n = "two"',
        "  print(s)",
        "  return 0",
      ),
      "keeps the string it read from n across a write to n",
    );
  });

  it("declines keeping a string read from a field across a call that writes one", () => {
    bothDecline(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "fn rename(p: P, s: string):",
        "  if s.length == 0:",
        "    return",
        "  p.n = s",
        "fn f(p: P) -> int:",
        "  s = p.n",
        '  rename(p, "two")',
        "  print(s)",
        "  return 0",
      ),
      "keeps the string it read from n across a call to rename",
    );
  });

  it("admits copying one field of owned text into another", () => {
    bothAdmit(
      src(
        "class P:",
        "  public constructor(n: string):",
        "    this.n = n",
        "fn f(a: P, b: P) -> int:",
        "  b.n = a.n",
        "  print(a.n)",
        "  print(b.n)",
        "  return 0",
      ),
    );
  });

  it("admits a returned string kept across a call that cannot rebuild it", () => {
    bothAdmit(
      src(
        "fn build(n: int) -> string:",
        '  return "v" + n.to_string()',
        "fn tag(n: int) -> int:",
        "  return n + 1",
        "fn f(n: int) -> int:",
        "  a = build(n)",
        "  print(tag(n))",
        "  print(a)",
        "  return 0",
      ),
    );
  });

  it("takes the string return type from the body when the source left it out", () => {
    bothAdmit(src("fn f(a: string, b: string):", "  return a + b"));
    bothAdmit(src("fn f():", '  return "hi"'));
  });

  it("refuses when the declared return type disagrees with the string returned", () => {
    bothRefuse(
      src("fn f(a: string, b: string) -> int:", "  return a + b"),
      "Type 'string' is not assignable to return type 'int'",
    );
  });
});

import { describe, expect, it } from "vitest";
import { BUILTIN_SET, KEYWORD_SET, TOKEN_RE, TYPE_SET, tokenClass } from "../src/highlight";

function paint(code: string): readonly { text: string; cls: string }[] {
  TOKEN_RE.lastIndex = 0;
  const painted: { text: string; cls: string }[] = [];
  for (const found of code.matchAll(TOKEN_RE)) {
    painted.push({ text: found[0], cls: tokenClass(found[0], code, found.index) });
  }
  return painted;
}

function classOf(code: string, token: string): string {
  return paint(code).find((entry) => entry.text === token)?.cls ?? "missing";
}

describe("deciding what colour a token of Tera source gets", () => {
  it("paints both comment forms as comments", () => {
    expect(classOf("x = 1  # counts up", "# counts up")).toBe("tok-com");
    expect(classOf("x = 1  // counts up", "// counts up")).toBe("tok-com");
  });

  it("paints a quoted literal as a string, whichever quote opened it", () => {
    expect(classOf('name = "tera"', '"tera"')).toBe("tok-str");
    expect(classOf("name = 'tera'", "'tera'")).toBe("tok-str");
  });

  it("keeps a half-typed string from flashing as keywords before its closing quote", () => {
    const unterminated = paint('label = "return the total');

    expect(unterminated.filter((entry) => entry.cls === "tok-str").map((entry) => entry.text)).toEqual([
      "return",
      "the",
      "total",
    ]);
    expect(classOf("return total", "return")).toBe("tok-kw");
  });

  it("recognises every numeric form the lexer accepts", () => {
    expect(classOf("a = 0xFF", "0xFF")).toBe("tok-num");
    expect(classOf("a = 0b1010", "0b1010")).toBe("tok-num");
    expect(classOf("a = 0o755", "0o755")).toBe("tok-num");
    expect(classOf("a = 1_000_000", "1_000_000")).toBe("tok-num");
    expect(classOf("a = 3.5e-2", "3.5e-2")).toBe("tok-num");
  });

  it("tells a property read from a method call by what follows the name", () => {
    expect(classOf("n = xs.length", "length")).toBe("tok-prop");
    expect(classOf("n = xs.length()", "length")).toBe("tok-method");
    expect(classOf("n = xs.push (1)", "push")).toBe("tok-method");
  });

  it("paints model hook labels like callable hooks", () => {
    const code = [
      "  forward (x: Tensor) -> Tensor:",
      "    return x",
      "  train (batch: Tensor[]):",
      "    return tensor(0.0)",
      "  validate (batch: Tensor[]):",
      "    return tensor(0.0)",
      "  optimizer:",
      "    return optim_config(SGD(Model.parameters()))",
    ].join("\n");

    expect(classOf(code, "forward")).toBe("tok-method");
    expect(classOf(code, "train")).toBe("tok-method");
    expect(classOf(code, "validate")).toBe("tok-method");
    expect(classOf(code, "optimizer")).toBe("tok-method");
  });

  it("does not paint ordinary hook names as model hook labels", () => {
    expect(classOf("optimizer = SGD(params)", "optimizer")).not.toBe("tok-method");
    expect(classOf("model.train()", "train")).toBe("tok-method");
  });

  it("paints interface members from their containing scope", () => {
    const code = [
      "interface ArrayGuard extends GuardSchema:",
      "  validate: (value: unknown, path?: string) -> GuardResultOf<unknown[]>",
      "  of: (schema: GuardSchema) -> ArrayGuard",
      "  fallback: string",
    ].join("\n");

    expect(classOf(code, "validate")).toBe("tok-method");
    expect(classOf(code, "of")).toBe("tok-method");
    expect(classOf(code, "fallback")).toBe("tok-prop");
  });

  it("paints braced literal keys as properties without stealing parameter names", () => {
    const code = [
      "guard: GuardApi = {",
      "  any: _make_any,",
      "  boolean: _make_boolean,",
      "  validate: validate,",
      "}",
    ].join("\n");

    expect(classOf(code, "any")).toBe("tok-prop");
    expect(classOf(code, "boolean")).toBe("tok-prop");
    expect(classOf(code, "validate")).toBe("tok-prop");
    expect(classOf("type Row = { maybe?: int }", "maybe")).toBe("tok-prop");
    expect(classOf("fn wrap(a: int, b: int) -> int:", "b")).toBe("tok-ident");
  });

  it("treats a name after a colon or an arrow as a type", () => {
    expect(classOf("fn work(n: int) -> int:", "int")).toBe("tok-type");
    expect(classOf("total: Point = p", "Point")).toBe("tok-type");
  });

  it("lets a keyword win over a type name that is not in annotation position", () => {
    const keyword = [...KEYWORD_SET].find((name) => !TYPE_SET.has(name))!;

    expect(classOf(`${keyword} x`, keyword)).toBe("tok-kw");
  });

  it("paints a known builtin as a builtin rather than a bare call", () => {
    const builtin = [...BUILTIN_SET].find((name) => !KEYWORD_SET.has(name) && !TYPE_SET.has(name))!;

    expect(classOf(`${builtin}(1)`, builtin)).toBe("tok-builtin");
  });

  it("falls back to a call, then a capitalised type, then a plain identifier", () => {
    expect(classOf("helper(1)", "helper")).toBe("tok-method");
    expect(classOf("p = Point", "Point")).toBe("tok-type");
    expect(classOf("p = total", "total")).toBe("tok-ident");
  });

  it("leaves no character of the line unaccounted for except punctuation and spaces", () => {
    const code = 'fn work(n: int) -> int:  # go\n  return "x"';
    const covered = paint(code).reduce((sum, entry) => sum + entry.text.length, 0);
    const punctuation = code.replace(/[\w$."'#/-]|\s/g, "").length;

    expect(covered).toBeGreaterThan(code.length - punctuation - code.split(/\s/).length);
  });
});

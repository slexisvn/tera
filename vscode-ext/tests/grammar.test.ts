import { describe, expect, it } from "vitest";
import { scopeOf, tokenizeLine } from "./grammar-harness.ts";

describe("grammar: declarations", () => {
  it("scopes a model declaration and its name", async () => {
    const line = "model IrisNet(num_classes: int):";
    expect(await scopeOf(line, "model")).toBe("keyword.other.declaration.tera");
    expect(await scopeOf(line, "IrisNet")).toBe("entity.name.type.tera");
    expect(await scopeOf(line, "int")).toBe("storage.type.tera");
  });

  it("scopes a fn declaration with a return type", async () => {
    const line = "fn square(n: int) -> int:";
    expect(await scopeOf(line, "fn")).toBe("keyword.other.declaration.tera");
    expect(await scopeOf(line, "square")).toBe("entity.name.function.tera");
    expect(await scopeOf(line, "->")).toBe("keyword.operator.arrow.tera");
  });

  it("does not mistake a fn-typed return for a type name", async () => {
    expect(await scopeOf("fn adder(base: int) -> fn(int) -> int:", "fn")).toBe("keyword.other.declaration.tera");
  });
});

describe("grammar: keywords and operators", () => {
  it("scopes word operators the lexer defines", async () => {
    expect(await scopeOf("if a and b or not c:", "and")).toBe("keyword.operator.word.tera");
    expect(await scopeOf("if a and b or not c:", "or")).toBe("keyword.operator.word.tera");
    expect(await scopeOf("if a and b or not c:", "not")).toBe("keyword.operator.word.tera");
    expect(await scopeOf("if a and b or not c:", "if")).toBe("keyword.control.tera");
  });

  it("scopes for-of as control flow", async () => {
    expect(await scopeOf("for step of range(200):", "of")).toBe("keyword.control.tera");
  });

  it("scopes matmul and constants", async () => {
    expect(await scopeOf("out = inp @ w", "@")).toBe("keyword.operator.tera");
    expect(await scopeOf("x = true", "true")).toBe("constant.language.tera");
    expect(await scopeOf("x = this", "this")).toBe("variable.language.tera");
  });
});

describe("grammar: numbers", () => {
  it.each([
    ["x = 0xFF_FF", "0xFF_FF", "constant.numeric.hex.tera"],
    ["x = 0b1010_1010", "0b1010_1010", "constant.numeric.binary.tera"],
    ["x = 0o755", "0o755", "constant.numeric.octal.tera"],
    ["x = 1_000_000", "1_000_000", "constant.numeric.decimal.tera"],
    ["x = 1.5e-9", "1.5e-9", "constant.numeric.decimal.tera"],
  ])("scopes %s", async (line, text, scope) => {
    expect(await scopeOf(line, text)).toBe(scope);
  });
});

describe("grammar: strings and comments", () => {
  it("scopes a template literal and its interpolation", async () => {
    const tokens = await tokenizeLine("s = `a ${x} b`");
    const scopesFor = (text: string) => tokens.find((token) => token.text === text)?.scopes ?? [];

    expect(scopesFor("a ")).toContain("string.template.tera");
    expect(scopesFor("${")).toContain("punctuation.definition.template-expression.begin.tera");
    expect(scopesFor("x")).toContain("meta.template.expression.tera");
    expect(scopesFor("x")).toContain("variable.other.tera");
  });

  it("scopes both comment styles", async () => {
    expect(await scopeOf("# note", "# note")).toBe("comment.line.number-sign.tera");
    expect(await scopeOf("// note", "// note")).toBe("comment.line.double-slash.tera");
  });

  it("scopes a regex literal but not division", async () => {
    expect((await scopeOf("m = /ab+c/gi", "/ab+c/gi"))).toBe("string.regexp.tera");
    expect(await scopeOf("q = a / b", "/")).toBe("keyword.operator.tera");
  });
});

describe("grammar: builtins", () => {
  it("scopes user calls apart from builtins", async () => {
    expect(await scopeOf("x = my_own_helper(1)", "my_own_helper")).toBe("entity.name.function.call.tera");
  });

  it.each([
    ["x = tensor([1.0])", "tensor", "support.function.factory.tera"],
    ["net = Linear(4, 8)", "Linear", "support.class.nn-module.tera"],
    ["opt = Adam(p)", "Adam", "support.class.optimizer.tera"],
    ["s = StepLR(opt, 5)", "StepLR", "support.class.scheduler.tera"],
    ["t = Trainer(max_epochs=3)", "Trainer", "support.class.trainer.tera"],
    ["m = Accuracy()", "Accuracy", "support.class.metric.tera"],
    ["c = chart.line(df)", "chart", "support.class.namespace.tera"],
  ])("scopes %s by its runtime kind", async (line, text, scope) => {
    expect(await scopeOf(line, text)).toBe(scope);
  });
});

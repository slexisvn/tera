import { describe, expect, it } from "vitest";
import { Engine, checkSource } from "../../src/index.js";
import { createDomainBuiltins } from "../../src/runtime/domain/builtins.js";

const run = (source: string) => new Engine().runValue(source).value;
const native = (source: string) => new Engine().runNative(source);

describe("Tera domain builtins and model", () => {
  it("runs tensor matmul through the domain registry", () => {
    const text = String(run("a = tensor([[1, 2], [3, 4]])\nb = tensor([[5, 6], [7, 8]])\n(a @ b).toString()"));
    expect(text).toContain("Tensor(shape=[2, 2]");
  });

  it("creates DataFrames with named arguments", async () => {
    await expect(Promise.resolve(native("df = DataFrame(a=[1, 2], b=[3, 4])\ndf.count()"))).resolves.toBe(2);
  });

  it("parses multiline named DataFrame and backtest calls", () => {
    const source = [
      "prices = DataFrame(",
      "  tech=[100, 102, 101, 105, 108, 107, 110, 113, 111, 115],",
      "  bank=[50, 49, 51, 50, 48, 49, 47, 48, 46, 45],",
      "  energy=[30, 31, 33, 32, 34, 36, 35, 37, 39, 38],",
      ")",
      "result = backtest(prices, signal=\"momentum\", portfolio=\"long_short\", lookback=3)",
      "result.metrics",
    ].join("\n");
    expect(native(source)).toBeTruthy();
  });

  it("runs model constructors, fields, and callable forward methods", () => {
    const source = [
      "model Linear:",
      "  weight = 2",
      "  forward(x):",
      "    return x * weight",
      "m = Linear()",
      "m(3)",
    ].join("\n");
    expect(run(source)).toBe(6);
  });

  it("adds model lifecycle helpers", () => {
    const model = [
      "model Tiny(input: int, output: int):",
      "  fc = Linear(input, output)",
      "  forward(x: Tensor) -> Tensor:",
      "    return fc(x)",
      "net = Tiny(2, 1)",
    ].join("\n");
    expect(run(`${model}\nnet.parameters().length`)).toBe(2);
    expect(run(`${model}\nnet.train(false)\nnet.is_training()`)).toBe(false);
    expect(String(run(`${model}\nnet.validate(randn([3, 2])).toString()`))).toContain("Tensor(shape=[3, 1]");
    expect(run(`${model}\nopt = net.optimizer(kind=\"sgd\", lr=0.01)\ntypeof opt.step`)).toBe("function");
    expect(run(`${model}\nopt = net.optimizer(kind=\"sgd\", lr=0.01)\nopt.step()`)).toBeUndefined();
  });

  it("compiles models through the global compile builtin", () => {
    const model = [
      "model Tiny(input: int, output: int):",
      "  fc = Linear(input, output)",
      "  forward(x: Tensor) -> Tensor:",
      "    return fc(x)",
      "net = Tiny(2, 1)",
    ].join("\n");
    expect(run(`${model}\ncompile(net, input=randn([3, 2])).parameters().length`)).toBe(2);
    expect(String(run(`${model}\ncompile(net, input=randn([3, 2])).validate(randn([3, 2])).toString()`))).toContain("Tensor(shape=[3, 1]");
  });

  it("uses domain metadata in type checking", () => {
    expect(checkSource("df = DataFrame(a=[1], b=[2])\ndf", "strict")).toEqual([]);
    expect(checkSource("model Tiny:\n  forward(x):\n    return x\nnet = Tiny()\ncompile(net, input=1)", "strict")).toEqual([]);
    expect(checkSource("compile(input=1)", "strict").map((d) => d.message).join("\n")).toContain("Missing required argument 'model'");
    expect(checkSource("zscore(window=\"bad\")", "strict").map((d) => d.message).join("\n")).toContain("window: number");
    expect(createDomainBuiltins().zscore.metadata?.params?.[0]?.name).toBe("window");
  });
});

import { describe, expect, it } from "vitest";
import { Engine, checkSource } from "../../src/index.js";
import { createDomainBuiltins } from "../../src/runtime/domain/builtins.js";

const run = (source: string) => new Engine().runValue(source).value;
const native = (source: string) => new Engine().runNative(source);

describe("Tera domain builtins and model", () => {
  it("runs tensor matmul through the domain registry", () => {
    const text = String(run("a = tensor([[1, 2], [3, 4]])\nb = tensor([[5, 6], [7, 8]])\n(a @ b).to_string()"));
    expect(text).toContain("Tensor(shape=[2, 2]");
  });

  describe("tensor operator overloading", () => {
    const tensors = "x = tensor([[1.0, 2.0], [3.0, 4.0]])\ny = tensor([[5.0, 6.0], [7.0, 8.0]])\n";
    const elementsOf = (expression: string) => {
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) })
        .runNative(`${tensors}print((${expression}).to_array())`);
      return out.join("");
    };

    it("dispatches arithmetic operators to the tensor methods", () => {
      expect(elementsOf("x + y")).toBe("[[6, 8], [10, 12]]");
      expect(elementsOf("x - y")).toBe("[[-4, -4], [-4, -4]]");
      expect(elementsOf("x * 2.0")).toBe("[[2, 4], [6, 8]]");
      expect(elementsOf("x / 2.0")).toBe("[[0.5, 1], [1.5, 2]]");
      expect(elementsOf("x ** 2.0")).toBe("[[1, 4], [9, 16]]");
      expect(elementsOf("x @ y")).toBe("[[19, 22], [43, 50]]");
    });

    it("dispatches unary negation to the tensor method", () => {
      expect(elementsOf("-x")).toBe("[[-1, -2], [-3, -4]]");
    });

    it("reflects commutative operators when the tensor is on the right", () => {
      expect(elementsOf("2.0 * x")).toBe("[[2, 4], [6, 8]]");
      expect(elementsOf("2.0 + x")).toBe("[[3, 4], [5, 6]]");
    });

    it("chains operators into tensor methods", () => {
      expect(run(`${tensors}((x * 2.0).sum()).to_array()`)).toBe(20);
    });

    it("keeps tensor operators working once the function is hot", () => {
      const source = [
        "fn step(t):",
        "  return (t * 2.0 + t) - t / 1.0",
        "x = tensor([[1.0, 2.0]])",
        "last = 0",
        "for i of range(3000):",
        "  last = step(x)",
        "print(last.to_array())",
      ].join("\n");
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative(source);
      expect(out.join("")).toBe("[[2, 4]]");
    }, 20000);

    it("rejects a non-commutative operator that has no left-hand method", () => {
      expect(() => run("x = tensor([[1.0]])\n2.0 - x")).toThrow(/requires a left operand with sub\(\)/);
      expect(() => run("1 @ 2")).toThrow(/requires a left operand with matmul\(\)/);
    });

    it("leaves plain JavaScript arithmetic untouched", () => {
      expect(run('"a" + "b"')).toBe("ab");
      expect(run('1 + "b"')).toBe("1b");
      expect(run("2 ** 10")).toBe(1024);
      expect(run("7 / 2")).toBe(3.5);
      expect(run("-5")).toBe(-5);
      expect(Number.isNaN(Number(run("o = {}\no - 1")))).toBe(true);
    });
  });

  describe("named arguments", () => {
    const printed = (source: string) => {
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative(source);
      return out.join("|");
    };

    it("routes a named argument into its positional slot", () => {
      const source = [
        "m = tensor([[1.0, 2.0]])",
        "print(stack([m, m], axis=0).shape)",
        "print(stack([m, m], axis=1).shape)",
        "print(cat([m, m], axis=1).shape)",
      ].join("\n");
      expect(printed(source)).toBe("[2, 1, 2]|[1, 2, 2]|[1, 4]");
    });

    it("accepts the native spelling of a positional slot", () => {
      expect(printed("m = tensor([[1.0, 2.0]])\nprint(cat([m, m], dim=1).shape)")).toBe("[1, 4]");
    });

    it("resolves device and dtype string options", () => {
      expect(printed("x = tensor([[1.0]], device=\"cpu\", dtype=\"f32\")\nprint(x.device, x.dtype)")).toBe("cpu f32");
    });

    it("does not expose device and dtype names as globals", () => {
      expect(() => native("tensor([[1.0]], dtype=f32)")).toThrow(/f32 is not defined/);
    });

    it("keeps options-object parameters out of the positional slots", () => {
      const source = [
        "loader = DataLoader(TensorDataset(randn([4, 2])), batch_size=2, shuffle=false)",
        "print(loader.length)",
      ].join("\n");
      expect(printed(source)).toBe("2");
    });
  });

  describe("autograd", () => {
    const printed = (source: string) => {
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative(source);
      return out.join("|");
    };

    it("maps the grad option onto the native requiresGrad flag", () => {
      const source = [
        "x = tensor([[1.0]], grad=true)",
        "y = (x ** 2.0).sum()",
        "y.backward()",
        "print(x.grad.to_array())",
      ].join("\n");
      expect(printed(source)).toBe("[[2]]");
    });

    it("still accepts the native option spelling", () => {
      const source = [
        "x = tensor([[1.0]], requires_grad=true)",
        "y = (x ** 2.0).sum()",
        "y.backward()",
        "print(x.grad.to_array())",
      ].join("\n");
      expect(printed(source)).toBe("[[2]]");
    });

    it("re-reads native getters instead of freezing them at wrap time", () => {
      const source = [
        "x = tensor([[1.0, 2.0]], grad=true)",
        "print(x.grad)",
        "f = (x ** 2.0).sum()",
        "f.backward()",
        "print(x.grad.to_array())",
      ].join("\n");
      expect(printed(source)).toBe("null|[[2, 4]]");
    });

    it("descends a gradient to the expected parameters", () => {
      const source = [
        "xs = tensor([[-2.0, -1.0], [-1.0, 2.0], [0.0, 0.0], [1.0, -2.0], [2.0, 1.0]])",
        "ys = tensor([[-6.0], [5.0], [1.0], [-3.0], [8.0]])",
        "w = zeros([2, 1], grad=true)",
        "b = zeros([1], grad=true)",
        "for step of range(200):",
        "  loss = ((xs @ w + b - ys) ** 2.0).mean()",
        "  loss.backward()",
        "  w = (w - 0.1 * w.grad).detach().requires_grad()",
        "  b = (b - 0.1 * b.grad).detach().requires_grad()",
        "print(w.to_array(), b.to_array())",
      ].join("\n");

      const [weights, bias] = JSON.parse(`[${printed(source).replace("] [", "], [")}]`);
      expect(weights[0][0]).toBeCloseTo(2, 3);
      expect(weights[1][0]).toBeCloseTo(3, 3);
      expect(bias[0]).toBeCloseTo(1, 3);
    });
  });

  it("creates DataFrames with named arguments", async () => {
    await expect(Promise.resolve(native("df = DataFrame(a=[1, 2], b=[3, 4])\ndf.count()"))).resolves.toBe(2);
  });

  it("exposes host object members through snake_case Tera names", () => {
    const out: string[] = [];
    const source = [
      "tok = Tokenizer()",
      "tok.fit([\"hello tera\"])",
      "x = tensor([1, 2])",
      "print(typeof tok.vocab_size)",
      "print(typeof tok.vocabSize)",
      "print(typeof tok.encode_batch)",
      "print(typeof tok.encodeBatch)",
      "print(typeof x.to_array)",
      "print(typeof x.toArray)",
    ].join("\n");
    new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative(source);
    expect(out.join("|")).toBe("number|undefined|function|undefined|function|undefined");
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

  it("delegates the module API to mlfw", () => {
    const model = [
      "model Tiny(input: int, output: int):",
      "  fc = Linear(input, output)",
      "  forward(x: Tensor) -> Tensor:",
      "    return fc(x)",
      "net = Tiny(2, 1)",
    ].join("\n");
    expect(run(`${model}\nnet.parameters().length`)).toBe(2);
    expect(run(`${model}\nnet.train(false)\nnet.training()`)).toBe(false);
    expect(run(`${model}\nnet.eval()\nnet.training()`)).toBe(false);
    expect(String(run(`${model}\nnet(randn([3, 2])).to_string()`))).toContain("Tensor(shape=[3, 1]");
    expect(run(`${model}\nopt = SGD(net.parameters(), lr=0.01)\ntypeof opt.step`)).toBe("function");
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
    expect(String(run(`${model}\ncompile(net, input=randn([3, 2]))(randn([3, 2])).to_string()`))).toContain("Tensor(shape=[3, 1]");
  });

  describe("tensor slicing", () => {
    const setup = "m = tensor([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]])\n";
    const sliced = (expr: string) => {
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative(`${setup}print((${expr}).to_array())`);
      return out.join("");
    };

    it("slices a range on two dimensions", () => {
      expect(sliced("m[0:2, 0:2]")).toBe("[[1, 2], [4, 5]]");
    });

    it("fills in an omitted lower or upper bound", () => {
      expect(sliced("m[1:, 1:]")).toBe("[[5, 6], [8, 9]]");
      expect(sliced("m[:2, :2]")).toBe("[[1, 2], [4, 5]]");
    });

    it("mixes a full-dimension slice with an index", () => {
      expect(sliced("m[:, 0]")).toBe("[1, 4, 7]");
    });

    it("leaves a plain element index as ordinary access", () => {
      const out: string[] = [];
      new Engine({ output: (text: unknown) => out.push(String(text)) }).runNative('a = [10, 20, 30]\nprint(a[1])');
      expect(out.join("")).toBe("20");
    });
  });

  describe("model lifecycle blocks", () => {
    const model = [
      "model Net(n: int):",
      "  w = Linear(n, 1)",
      "  forward(x: Tensor) -> Tensor:",
      "    return w(x)",
      "  optimizer:",
      "    return optim_config(Adam(Net.parameters(), lr=0.01))",
      "net = Net(4)",
    ].join("\n");

    it("parses a parameterless optimizer block", () => {
      expect(run(`${model}\ntypeof net.optimizer()`)).toBe("object");
    });

    it("resolves the model name to the instance inside a method", () => {
      expect(run(`${model}\nnet.parameters().length`)).toBe(2);
    });
  });

  it("uses domain metadata in type checking", () => {
    expect(checkSource("df = DataFrame(a=[1], b=[2])\ndf", "strict")).toEqual([]);
    expect(checkSource("model Tiny:\n  forward(x):\n    return x\nnet = Tiny()\ncompile(net, input=1)", "strict")).toEqual([]);
    expect(checkSource("compile(input=1)", "strict").map((d) => d.message).join("\n")).toContain("Missing required argument 'model'");
    expect(checkSource("zscore(window=\"bad\")", "strict").map((d) => d.message).join("\n")).toContain("window: int");
    expect(createDomainBuiltins().zscore.metadata?.params?.[0]?.name).toBe("window");
  });

  it("normalizes package record keys to snake_case", () => {
    expect(native("result = adf_test([1, 2, 3, 4, 5])\n[result.critical_values.five, typeof result.criticalValues]")).toEqual([
      -3.8487400000000003,
      "undefined",
    ]);
  });
});

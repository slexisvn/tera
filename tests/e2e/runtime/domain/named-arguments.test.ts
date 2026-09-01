import { describe, expect, it } from "vitest";
import { Engine } from "../../../../src/index.js";
import { hostEngineOptions } from "../../../../src/cli/host.js";

async function printed(source: string): Promise<string> {
  const out: string[] = [];
  const engine = new Engine({ ...hostEngineOptions(), output: (text: unknown) => out.push(String(text)) });
  await engine.runNative(source);
  return out.join("\n");
}

const TENSOR = "t = tensor([[1.0, 5.0, 2.0], [7.0, 0.0, 3.0]])\n";
const tensor = (expression: string) => printed(`${TENSOR}print((${expression}).to_array())`);

describe("named arguments on host methods", () => {
  it("binds a named argument to the slot the method declares", async () => {
    expect(await tensor("t.argmax(axis=1)")).toBe(await tensor("t.argmax(1)"));
    expect(await tensor("t.argmax(axis=1)")).toBe("[1, 0]");
  });

  it("reduces over the named axis instead of ignoring it", async () => {
    expect(await tensor("t.sum(axis=1)")).toBe("[8, 10]");
  });

  it("accepts dim as a synonym of the declared axis parameter", async () => {
    expect(await tensor("t.argmax(dim=1)")).toBe(await tensor("t.argmax(1)"));
  });

  it("binds named arguments given out of declaration order", async () => {
    expect(await tensor("t.mean(keep=true, axis=1)")).toBe(await tensor("t.mean(1, true)"));
  });

  it("binds a camelCase spelling of a snake_case parameter", async () => {
    expect(await printed(`${TENSOR}print(t.transpose(dim0=0, dim1=1).shape)`)).toBe("[3, 2]");
  });

  it("binds a named argument on a dataframe method", async () => {
    expect(await printed("print(DataFrame(a=[1, 2, 3, 4, 5]).head(n=2).count())")).toBe("2");
  });
});

describe("named arguments on builtin prototype methods", () => {
  it("binds a named argument on an array method", async () => {
    expect(await printed("print([3, 1, 2].slice(start=1))")).toBe("[1, 2]");
  });

  it("binds a named argument on a string method", async () => {
    expect(await printed('print("hello".char_code_at(index=1))')).toBe(String("e".charCodeAt(0)));
  });
});

describe("named arguments the callee reads as options", () => {
  it("keeps a named-only parameter out of the positional slots", async () => {
    expect(await printed('print(zeros([2, 2], dtype="i32").dtype)')).toBe("i32");
  });

  it("still binds the positional parameters of a global builtin", async () => {
    expect(await printed("print(full([2, 2], value=9.0).to_array())")).toBe("[[9, 9], [9, 9]]");
  });

  it("rejects a name a fully positional method does not declare", async () => {
    await expect(tensor("t.argmax(axis=1, unknown_option=true)")).rejects.toThrow(
      /Unknown named argument 'unknown_option'/,
    );
  });

  it("still passes an undeclared name to a callee that takes options", async () => {
    expect(await printed('print(zeros([2, 2], dtype="i32", unknown_option=true).dtype)')).toBe("i32");
  });
});

describe("named arguments on Tera functions", () => {
  it("still binds by parameter name", async () => {
    expect(await printed("fn scale(n: int, by: int) -> int:\n  return n * by\nprint(scale(by=3, n=4))")).toBe("12");
  });

  it("still rejects a name the function does not declare", async () => {
    await expect(printed("fn scale(n: int) -> int:\n  return n\nprint(scale(nope=3))")).rejects.toThrow(
      /Unknown named argument 'nope'/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function compiled(source: string, backend = "c") {
  return nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend });
}

function agrees(source: string): void {
  const program = compiled(source, "x64-windows");
  expect(program.skipped).toEqual([]);
  const run = runPe(
    nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
      backend: "x64-windows",
      format: "executable",
    }).files[0]!.contents as Uint8Array,
  );

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function signatureOf(source: string, name: string): string {
  const program = compiled(source);
  expect(program.skipped).toEqual([]);
  const text = program.files.find((file) => file.name.endsWith(".c"))!.contents as string;
  const declared = new RegExp(`^[^\\n]*\\b${name}\\([^\\n]*\\{`, "m").exec(text);
  expect(declared).not.toBeNull();
  return declared![0]!.trim();
}

describe("AOT parameter types read off the call sites", () => {
  itRunsPe("compiles a function whose parameters the source never declared", () => {
    agrees(src("fn add(a, b):", "  return a + b", "print(add(3, 4))"));
  });

  itRunsPe("agrees with the interpreter when the argument is a float", () => {
    agrees(src("fn half(x):", "  return x * 0.5", "print(half(9.5))"));
  });

  itRunsPe("carries an inferred type through two call sites that agree", () => {
    agrees(src("fn twice(n):", "  return n + n", "print(twice(2) + twice(5))"));
  });

  it("gives the parameter the type its callers pass", () => {
    expect(signatureOf(src("fn half(x):", "  return x * 0.5", "print(half(9.5))"), "half")).toBe(
      "double half(double p0) {",
    );
    expect(signatureOf(src("fn add(a, b):", "  return a + b", "print(add(3, 4))"), "add")).toContain(
      "int32_t p1",
    );
  });

  itRunsPe("widens a parameter that one caller passes as int and another as float", () => {
    agrees(src("fn scale(v):", "  return v * 2", "print(scale(3))", "print(scale(2.5))"));
  });

  it("keeps a parameter int when every caller passes an int", () => {
    expect(
      signatureOf(
        src("fn scale(v):", "  return v * 2", "print(scale(3))", "print(scale(4))"),
        "scale",
      ),
    ).toBe("int32_t scale(int32_t p0) {");
  });

  it("widens to the type that holds both when the callers differ in width", () => {
    expect(
      signatureOf(
        src("fn scale(v):", "  return v * 2", "print(scale(3))", "print(scale(2.5))"),
        "scale",
      ),
    ).toBe("double scale(double p0) {");
  });

  it("refuses a parameter whose call sites disagree", () => {
    const build = () =>
      compiled(src("fn show(v):", "  return v", "print(show(1))", 'print(show("a"))'));

    expect(build).toThrow("needs every parameter to have a declared type");
  });

  it("refuses a parameter no call site ever passes", () => {
    const build = () => compiled(src("fn twice(v):", "  return v + v", "print(21)"));

    expect(build).toThrow("twice: parameter 'v' has no declared type");
  });

  it("leaves a declared parameter as the source wrote it", () => {
    expect(
      signatureOf(
        src("fn half(x: float) -> float:", "  return x * 0.5", "print(half(9.0))"),
        "half",
      ),
    ).toBe("double half(double p0) {");
  });
});

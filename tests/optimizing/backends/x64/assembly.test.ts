import { describe, expect, it } from "vitest";
import { Engine } from "../../../../src/api/engine.js";
import { createX64Backend } from "../../../../src/optimizing/backends/x64/backend.js";
import type { AotProgram } from "../../../../src/optimizing/drivers/aot.js";

const src = (...lines: string[]) => lines.join("\n");

function fileOf(program: AotProgram, extension: string): string {
  const file = program.files.find((candidate) => candidate.name.endsWith(extension));
  if (file === undefined) throw new Error(`program has no ${extension} output`);
  return String(file.contents);
}

function programWith(
  source: string,
  abi?: "sysv" | "win64",
  format?: "elf" | "coff",
): AotProgram {
  const engine = new Engine({ typecheck: "off" });
  if (abi !== undefined) engine.backends.register(createX64Backend({ abi, format }));
  const program = engine.compileAot(source, { backend: "x64" });
  if (program.skipped.length > 0) {
    throw new Error(`skipped: ${program.skipped.map((fn) => fn.reason).join("; ")}`);
  }
  return program;
}

function assemblyOf(source: string): string {
  return fileOf(programWith(source), ".s");
}

describe("x64 assembly", () => {
  it("reads the first integer argument out of the argument register", () => {
    const assembly = assemblyOf(src("fn twice(n: int) -> int:", "  return n + n"));
    const incoming = process.platform === "win32" ? "%ecx" : "%edi";

    expect(assembly).toContain(`movl ${incoming}, `);
    expect(assembly).toMatch(/leal\s+0\(%r\w+,%r\w+,1\), %e\w+/);
  });

  it("materialises an integer constant as an immediate", () => {
    const assembly = assemblyOf(src("fn seven() -> int:", "  return 7"));

    expect(assembly).toContain("movl $7, ");
    expect(assembly).toMatch(/movl\s+%e\w+, %eax/);
  });

  it("emits doubles into read only data and loads them rip relative", () => {
    const assembly = assemblyOf(src("fn half() -> float:", "  return 0.5"));

    expect(assembly).toContain('.section .rdata,"dr"');
    expect(assembly).toMatch(/\.quad 0x3fe0000000000000/);
    expect(assembly).toMatch(/movsd\s+\.LC0\w*\(%rip\), %xmm\d+/);
  });

  it("fuses an integer comparison into a conditional jump", () => {
    const assembly = assemblyOf(
      src("fn pick(a: int, b: int) -> int:", "  if a < b:", "    return a", "  return b"),
    );

    expect(assembly).toMatch(/cmpl\s+%\w+, %\w+/);
    expect(assembly).toMatch(/jl\s+\.L/);
    expect(assembly).not.toContain("setl");
  });

  it("guards float equality against unordered operands", () => {
    const assembly = assemblyOf(
      src("fn same(a: float, b: float) -> int:", "  r = a == b", "  return r"),
    );

    expect(assembly).toContain("ucomisd");
    expect(assembly).toContain("sete");
    expect(assembly).toContain("setnp");
    expect(assembly).toContain("andl");
  });

  it("uses a scaled index addressing mode for element access", () => {
    const assembly = assemblyOf(
      src("fn at(i: int) -> float:", "  data = [1.5, 2.5]", "  return data[i]"),
    );

    expect(assembly).toMatch(/movslq\s+%e\w+, %r\w+/);
    expect(assembly).toMatch(/movsd\s+\d+\(%rsp,%r\w+,8\), %xmm\d+/);
  });

  it("keeps the stack pointer aligned for a call", () => {
    const assembly = assemblyOf(
      src(
        "fn leaf(x: float) -> float:",
        "  return x + 1.0",
        "fn caller(x: float) -> float:",
        "  return leaf(x) * 2.0",
      ),
    );
    const frame = assembly.match(/caller:\n\tsubq \$(\d+), %rsp/);

    expect(frame).not.toBeNull();
    expect((Number(frame![1]) + 8) % 16).toBe(0);
  });

  it("reserves Win64 shadow space and no more than needed on SysV", () => {
    const source = src(
      "fn leaf(x: float) -> float:",
      "  return x + 1.0",
      "fn caller(x: float) -> float:",
      "  return leaf(x)",
    );
    const frameOf = (text: string) =>
      Number(text.match(/caller:\n\tsubq \$(\d+), %rsp/)![1]);
    const forWin = frameOf(fileOf(programWith(source, "win64", "coff"), ".s"));
    const forSysV = frameOf(fileOf(programWith(source, "sysv", "elf"), ".s"));

    expect(forWin).toBeGreaterThanOrEqual(32);
    expect(forSysV).toBeLessThan(forWin);
  });

  it("follows the object format of the target it was built for", () => {
    const source = src("fn one() -> int:", "  return 1");

    expect(fileOf(programWith(source, "sysv", "elf"), ".s")).toContain(
      "\t.type one, @function",
    );
    expect(fileOf(programWith(source, "win64", "coff"), ".s")).toContain(
      "\t.def one; .scl 2; .type 32; .endef",
    );
  });

  it("emits a C header the other AOT backends could also produce", () => {
    const header = fileOf(
      programWith(src("fn add(a: int, b: float) -> float:", "  return a + b")),
      ".h",
    );

    expect(header).toContain("#include <stdint.h>");
    expect(header).toContain("double add(int32_t p0, double p1);");
  });

  it("emits a runtime routine only when a function references it", () => {
    const withHelper = assemblyOf(
      src("fn rem(a: int, b: int) -> int:", "  return (a % b) + 0"),
    );
    const withoutHelper = assemblyOf(src("fn sum(a: int, b: int) -> int:", "  return a + b"));

    expect(withHelper).toContain("tera_x64_i32_mod:");
    expect(withoutHelper).not.toContain("tera_x64_i32_mod:");
  });
});

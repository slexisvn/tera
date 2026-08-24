import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Engine } from "../../../src/index.js";
import { parseArgs } from "../../../src/cli/args.js";
import { runCompile } from "../../../src/cli/compile.js";
import { HOST_PLATFORM, hostBackendId } from "../../../src/optimizing/backends/index.js";
import { itNative } from "../../helpers/c-executor.js";

const src = (...lines: string[]) => lines.join("\n");

const itBuildsNatively = it.skipIf(hostBackendId() === null);

interface Build {
  readonly status: number;
  readonly output: string;
  readonly directory: string;
  readonly errors: readonly string[];
}

function inWorkspace<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tera-cli-compile-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compile(dir: string, source: string, extraArgs: readonly string[] = []): Build {
  const input = join(dir, "input.tera");
  const output = join(dir, process.platform === "win32" ? "out.exe" : "out");
  writeFileSync(input, `${source}\n`);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => void errors.push(String(message));
  try {
    const status = runCompile(parseArgs(["compile", input, "-o", output, ...extraArgs]));
    return { status, output, directory: dir, errors };
  } finally {
    console.error = originalError;
  }
}

function run(binary: string): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.trim() };
}

function output(binary: string): string {
  const result = run(binary);
  if (result.status !== 0) throw new Error(`binary exited with ${result.status}`);
  return result.stdout;
}

const SQUARES = src(
  "fn squares() -> int:",
  "  total = 0",
  "  i = 0",
  "  while i < 10:",
  "    total = total + i * i",
  "    i = i + 1",
  "  return total",
  "",
  "print(squares())",
);

const CALLS_UNLOWERABLE = src(
  "fn describe(n: int) -> string:",
  "  return n.to_string(16)",
  "print(describe(255))",
);

const KEEPS_UNLOWERABLE_ASIDE = src(
  "fn describe(n: int) -> string:",
  "  return n.to_string(16)",
  "print(255)",
);

const REACTIVE = src(
  "signal price = 12.5",
  "computed total = price * 2",
  "print(total)",
);

const CALLS_UNLOWERABLE_THROUGH = src(
  "fn describe(n: int) -> string:",
  "  return n.to_string(16)",
  "fn label(n: int) -> string:",
  "  return describe(n)",
  "print(label(255))",
);

describe("tera compile", () => {
  itBuildsNatively("builds a runnable binary without any external toolchain", () => {
    inWorkspace((dir) => {
      const interpreted = new Engine({ typecheck: "off" }).runNative(`${SQUARES}\nsquares()`);
      const built = compile(dir, SQUARES);

      expect(built.status).toBe(0);
      expect(Number(output(built.output))).toBe(interpreted);
    });
  });

  itBuildsNatively("prints a string the top level asked for", () => {
    inWorkspace((dir) => {
      const built = compile(dir, 'print("H2O balanced")');

      expect(built.status).toBe(0);
      expect(output(built.output)).toBe("H2O balanced");
    });
  });

  itBuildsNatively("prints a string built at runtime", () => {
    const source = src(
      "fn label() -> string:",
      '  out = ""',
      "  i = 1",
      "  while i <= 3:",
      '    out = out + i.to_string() + "H2O "',
      "    i = i + 1",
      "  return out",
      "",
      "print(label())",
    );

    inWorkspace((dir) => {
      const interpreted = new Engine({ typecheck: "off" }).runNative(`${source}\nlabel()`);
      const built = compile(dir, source);

      expect(built.status).toBe(0);
      expect(output(built.output)).toBe(String(interpreted).trim());
    });
  });

  itBuildsNatively("delivers a named entry result as the exit status when asked", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 42"), [
        "--entry=main",
        "--result=exit",
      ]);

      expect(built.status).toBe(0);
      expect(run(built.output)).toEqual({ status: 42, stdout: "" });
    });
  });

  itBuildsNatively("exits successfully when the top level says nothing", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn unused() -> int:", "  return 1"));

      expect(built.status).toBe(0);
      expect(run(built.output)).toEqual({ status: 0, stdout: "" });
    });
  });

  itBuildsNatively("names the artifact after the input when no output is given", () => {
    inWorkspace((dir) => {
      const input = join(dir, "greeting.tera");
      writeFileSync(input, src("fn main() -> string:", '  return "hi"'));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        expect(runCompile(parseArgs(["compile", input]))).toBe(0);
      } finally {
        process.chdir(cwd);
      }

      expect(existsSync(join(dir, `greeting${process.platform === "win32" ? ".exe" : ""}`))).toBe(
        true,
      );
    });
  });

  itBuildsNatively("cross compiles to another platform on request", () => {
    inWorkspace((dir) => {
      const foreign = HOST_PLATFORM.os === "linux" ? "windows" : "linux";
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        `--platform=${foreign}`,
      ]);

      expect(built.status).toBe(0);
      expect(existsSync(built.output)).toBe(true);
    });
  });

  itBuildsNatively("writes an object next to the header that declares it", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn twice(n: int) -> int:", "  return n + n"), [
        "--emit=obj",
      ]);

      expect(built.status).toBe(0);
      expect(existsSync(built.output)).toBe(true);
      expect(readFileSync(join(dir, "input.h"), "utf8")).toContain("twice");
    });
  });
});

describe("tera compile --target=c", () => {
  itNative("builds through the C toolchain", () => {
    inWorkspace((dir) => {
      const interpreted = new Engine({ typecheck: "off" }).runNative(`${SQUARES}\nsquares()`);
      const built = compile(dir, SQUARES, ["--target=c"]);

      expect(built.status).toBe(0);
      expect(Number(output(built.output))).toBe(interpreted);
    });
  });

  itNative("writes the sources it would have compiled", () => {
    inWorkspace((dir) => {
      const sources = join(dir, "sources");
      const built = compile(dir, src("fn main() -> int:", "  return 7"), [
        "--target=c",
        "--emit=source",
        "-o",
        sources,
      ]);

      expect(built.status).toBe(0);
      expect(readFileSync(join(sources, "input.c"), "utf8")).toContain("tera_main");
      expect(readFileSync(join(sources, "input.h"), "utf8")).toContain("tera_main(void)");
    });
  });

  itNative("keeps the intermediates it handed to the compiler", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--target=c",
        "--keep-temps",
      ]);
      const kept = built.errors.find((line) => line.includes("kept intermediates in"));

      expect(built.status).toBe(0);
      expect(kept).toBeDefined();
      const buildDir = kept!.slice(kept!.indexOf("kept intermediates in ") + 22).trim();
      expect(readFileSync(join(buildDir, "main.c"), "utf8")).toContain('#include "input.h"');
      rmSync(buildDir, { recursive: true, force: true });
    });
  });

  itNative("refuses to write an executable itself for a target that cannot", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--target=c",
        "--link=none",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("cannot write an executable itself");
    });
  });

  itNative("refuses an artifact the target cannot emit", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--target=c",
        "--emit=obj",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("cannot emit obj");
    });
  });

  it("reads the syntax the run path reads", () => {
    inWorkspace((dir) => {
      const built = compile(dir, REACTIVE, ["--target=c", "--emit=source"]);

      expect(built.errors.join("\n")).not.toContain("[Parser]");
    });
  });

  it("reports what it cannot lower in reactive syntax instead of failing to parse", () => {
    inWorkspace((dir) => {
      const built = compile(dir, REACTIVE, ["--target=c", "--emit=source"]);

      expect(built.errors.join("\n")).toContain("cannot emit");
    });
  });
});

describe("tera compile entry reporting", () => {
  it("reports an entry the backend could not lower instead of writing a binary", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  n: int = 255", "  print(n.to_string(16))", "  return 0"), [
        "--entry=main",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("could not be lowered to native code");
    });
  });

  it("reports an entry that takes parameters", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main(n: int) -> int:", "  return n"), [
        "--entry=main",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain(
        "takes no parameters; read what it needs with input()",
      );
    });
  });

  it("reports a top level the backend could not lower", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("n: int = 255", "print(n.to_string(16))"));

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("could not be lowered to native code");
      expect(built.errors.join("\n")).not.toContain("it calls");
    });
  });

  it("warns about every skipped function before reporting the failure", () => {
    inWorkspace((dir) => {
      const built = compile(dir, CALLS_UNLOWERABLE);

      expect(built.status).toBe(1);
      expect(built.errors).toHaveLength(3);
      expect(built.errors[0]).toContain(
        "warning: skipped 'describe' (",
      );
      expect(built.errors[0]).toContain("int.to_string has an unsupported argument count");
      expect(built.errors[1]).toBe(
        "tera compile: warning: skipped 'tera_program' (calls unavailable function describe)",
      );
    });
  });

  itBuildsNatively("says a function it left out is not one the program runs", () => {
    inWorkspace((dir) => {
      const built = compile(dir, KEEPS_UNLOWERABLE_ASIDE);

      expect(built.status).toBe(0);
      expect(built.errors.join("\n")).toContain(
        "note: 'describe' is not in the binary, and nothing the program runs calls it",
      );
      expect(built.errors.join("\n")).not.toContain("warning");
      expect(output(built.output)).toBe("255");
    });
  });

  it("blames the first cause of a dropped entry rather than the call that dropped it", () => {
    inWorkspace((dir) => {
      const built = compile(dir, CALLS_UNLOWERABLE_THROUGH);

      expect(built.errors.at(-1)).toContain(
        "entry function tera_program could not be lowered to native code: it calls label -> " +
          "describe, skipped because",
      );
      expect(built.errors.at(-1)).toContain("int.to_string has an unsupported argument count");
    });
  });

  it("refuses a program whose parameters have no declared type", () => {
    inWorkspace((dir) => {
      const built = compile(
        dir,
        src("fn twice(v):", "  return v + v", "", "print(21)"),
      );

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain(
        "compiling ahead of time needs every parameter to have a declared type",
      );
      expect(built.errors.join("\n")).toContain(
        "twice: parameter 'v' has no declared type",
      );
      expect(existsSync(built.output)).toBe(false);
    });
  });

  it("refuses an untyped function even when nothing the entry needs calls it", () => {
    inWorkspace((dir) => {
      const built = compile(
        dir,
        src("fn unused(v):", "  return v + v", "", "print(21)"),
      );

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("unused: parameter 'v' has no declared type");
      expect(existsSync(built.output)).toBe(false);
    });
  });

  itBuildsNatively("builds the same program once its parameters are declared", () => {
    inWorkspace((dir) => {
      const built = compile(
        dir,
        src("fn twice(v: int) -> int:", "  return v + v", "", "print(twice(21))"),
      );

      expect(built.status).toBe(0);
      expect(output(built.output)).toBe("42");
    });
  });

  it("names an unknown architecture and lists the ones it knows", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), ["--target=x86"]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("unknown target 'x86'");
      expect(built.errors.join("\n")).toContain("x64");
    });
  });

  it("refuses a platform the architecture does not build for", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--platform=plan9",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("no target builds");
    });
  });

  it("refuses a platform for a portable target", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--target=c",
        "--platform=linux",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("--platform does not apply");
    });
  });

  it("refuses an artifact a half-finished target cannot produce", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--target=riscv64",
        "--emit=obj",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("cannot emit obj");
    });
  });

  it("refuses to link a foreign platform with the host compiler", () => {
    inWorkspace((dir) => {
      const built = compile(dir, src("fn main() -> int:", "  return 1"), [
        "--target=riscv64",
      ]);

      expect(built.status).toBe(1);
      expect(built.errors.join("\n")).toContain("is not this machine");
    });
  });
});

describe("tera compile across targets", () => {
  itNative("agrees with the C toolchain on what the program prints", () => {
    const source = src(
      "fn joined() -> string:",
      '  out = ""',
      "  i = 1",
      "  while i <= 3:",
      '    out = out + i.to_string() + ";"',
      "    i = i + 1",
      "  return out",
      "",
      "print(joined())",
    );

    inWorkspace((dir) => {
      const portable = compile(dir, source, ["--target=c"]);
      const portableOutput = output(portable.output);
      const native = compile(dir, source);

      expect(native.status).toBe(0);
      expect(output(native.output)).toBe(portableOutput);
    });
  });
});

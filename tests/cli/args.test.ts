import { describe, expect, it } from "vitest";
import { parseArgs, CliUsageError } from "../../src/cli/args.js";
import { commandHelp, generalHelp, helpFor } from "../../src/cli/help.js";
import { COMMANDS, commandNamed } from "../../src/cli/spec.js";
import type { CompileConfig, RunConfig } from "../../src/cli/config.js";

function runConfig(argv: readonly string[]): RunConfig {
  const config = parseArgs(argv);
  if (config.command !== "run") throw new Error(`expected run, got ${config.command}`);
  return config;
}

function compileConfig(argv: readonly string[]): CompileConfig {
  const config = parseArgs(argv);
  if (config.command !== "compile") throw new Error(`expected compile, got ${config.command}`);
  return config;
}

describe("command selection", () => {
  it("runs the files it is given without naming a command", () => {
    expect(runConfig(["app.tera"]).files).toEqual(["app.tera"]);
  });

  it("starts the repl when there is nothing to run", () => {
    expect(parseArgs([]).command).toBe("repl");
  });

  it("keeps engine flags when it falls back to the repl", () => {
    const config = parseArgs(["--no-opt"]);

    expect(config).toMatchObject({ command: "repl", optMode: "none" });
  });

  it("takes the first token as the command when it names one", () => {
    expect(parseArgs(["check", "app.tera"]).command).toBe("check");
  });

  it("treats a file named like a command as a file after the separator", () => {
    expect(runConfig(["--", "compile"]).files).toEqual(["compile"]);
  });

  it("reads stdin for the bare dash", () => {
    expect(runConfig(["-"]).readStdin).toBe(true);
  });
});

describe("flag parsing", () => {
  it("accepts a value attached to the flag or standing after it", () => {
    expect(compileConfig(["compile", "a.tera", "-o", "out"]).output).toBe("out");
    expect(compileConfig(["compile", "a.tera", "--output=out"]).output).toBe("out");
  });

  it("reads source given to the eval flag in either form", () => {
    expect(runConfig(["-e", "1 + 1"]).eval).toBe("1 + 1");
    expect(runConfig(["--eval=1 + 1"]).eval).toBe("1 + 1");
  });

  it("leaves the positional alone when an optional value is absent", () => {
    const config = runConfig(["--trace", "app.tera"]);

    expect(config.traceCategories).toEqual(["all"]);
    expect(config.files).toEqual(["app.tera"]);
  });

  it("splits a comma list given to the tracer", () => {
    expect(runConfig(["--trace=jit,deopt", "app.tera"]).traceCategories).toEqual([
      "jit",
      "deopt",
    ]);
  });

  it("rejects a flag that belongs to another command", () => {
    expect(() => parseArgs(["compile", "a.tera", "--print-bytecode"])).toThrow(
      /unknown option '--print-bytecode' for 'compile'/,
    );
  });

  it("points at the help of the command it was parsing", () => {
    expect(() => parseArgs(["compile", "a.tera", "--nope"])).toThrow(/tera help compile/);
  });

  it("rejects a value the flag does not offer", () => {
    expect(() => parseArgs(["compile", "a.tera", "--emit=binary"])).toThrow(
      /--emit expects exe\|obj\|source/,
    );
  });

  it("rejects a missing value", () => {
    expect(() => parseArgs(["compile", "a.tera", "--entry"])).toThrow(/requires a value/);
  });

  it("rejects a value on a flag that takes none", () => {
    expect(() => parseArgs(["--no-opt=1", "app.tera"])).toThrow(/does not take a value/);
  });

  it("rejects a second input file for a command that compiles one", () => {
    expect(() => parseArgs(["compile", "a.tera", "b.tera"])).toThrow(
      /takes exactly one input file/,
    );
  });

  it("rejects arguments to a command that takes none", () => {
    expect(() => parseArgs(["repl", "app.tera"])).toThrow(/takes no arguments/);
  });

  it("reports usage problems as usage errors", () => {
    expect(() => parseArgs(["--nope"])).toThrow(CliUsageError);
  });
});

describe("compile defaults", () => {
  it("asks for an executable built from the top level of the file", () => {
    expect(compileConfig(["compile", "a.tera"])).toMatchObject({
      emit: "exe",
      link: "auto",
      result: null,
      entry: null,
      target: null,
    });
  });

  it("still takes an explicit entry function and result mode", () => {
    expect(compileConfig(["compile", "a.tera", "--entry=main", "--result=exit"])).toMatchObject({
      result: "exit",
      entry: "main",
    });
  });
});

describe("help", () => {
  it("answers the help flag before it parses anything else", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help", topic: null });
    expect(parseArgs(["-h"])).toEqual({ command: "help", topic: null });
  });

  it("answers the help flag with the command it followed", () => {
    expect(parseArgs(["compile", "--help"])).toEqual({ command: "help", topic: "compile" });
  });

  it("answers the help command with its topic", () => {
    expect(parseArgs(["help", "compile"])).toEqual({ command: "help", topic: "compile" });
  });

  it("answers the version flag", () => {
    expect(parseArgs(["-v"]).command).toBe("version");
  });

  it("lists every command it can run", () => {
    const text = generalHelp();

    for (const command of COMMANDS) expect(text).toContain(command.name);
  });

  it("documents every flag the command declares", () => {
    for (const command of COMMANDS) {
      const text = commandHelp(command);
      for (const flag of command.flags) expect(text).toContain(`--${flag.name}`);
    }
  });

  it("falls back to the general help for a topic it does not know", () => {
    expect(helpFor("nope")).toBe(generalHelp());
  });

  it("names the arguments each command takes", () => {
    expect(commandHelp(commandNamed("compile")!)).toContain("tera compile <file>");
  });
});

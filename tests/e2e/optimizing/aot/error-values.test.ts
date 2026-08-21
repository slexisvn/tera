import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { TERA_EXIT_UNCAUGHT_THROW } from "../../../../src/optimizing/target/faults.js";

const src = (...lines: string[]) => lines.join("\n");

function interpreted(source: string): string {
  const stream: string[] = [];
  nodeEngine({ typecheck: "off", output: (text) => stream.push(`${text}\n`) }).run(`${source}\n`);
  return stream.join("");
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  return program.files[0]!.contents as Uint8Array;
}

function agrees(source: string): void {
  const run = runPe(image(source));

  expect(run.status).toBe(0);
  expect(run.stdout).toBe(interpreted(source));
}

function declines(source: string): void {
  expect(() =>
    nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
      backend: "x64-windows",
      format: "executable",
    }),
  ).toThrow(/cannot emit/);
}

describe("AOT error values", () => {
  itRunsPe("reads the message off an error it caught", () => {
    agrees(
      src("try:", '  throw Error("boom")', "catch e:", "  print(e.message)"),
    );
  });

  itRunsPe("carries an error out of the function that raised it", () => {
    agrees(
      src(
        "fn risky(n: int) -> int:",
        "  if n < 0:",
        '    throw Error("negative")',
        "  return n",
        "try:",
        "  print(risky(3))",
        "  print(risky(-1))",
        "catch e:",
        '  print("caught", e.message)',
      ),
    );
  });

  itRunsPe("reads the message off a class that extends Error", () => {
    agrees(
      src(
        "class AppError extends Error:",
        "  public constructor(msg: string):",
        "    super(msg)",
        "try:",
        '  throw AppError("bad input")',
        "catch e:",
        "  print(e.message)",
      ),
    );
  });

  itRunsPe("reports an error nobody caught the way the interpreter names it", () => {
    const run = runPe(
      image(src('print("before")', 'throw Error("boom")')),
    );

    expect([run.status, run.stdout, run.stderr]).toEqual([
      TERA_EXIT_UNCAUGHT_THROW,
      "before\n",
      "Uncaught Error: boom\n",
    ]);
  });

  itRunsPe("mixes a plain error with a subclass in one program", () => {
    agrees(
      src(
        "fn risky(n: int) -> int:",
        "  if n < 0:",
        '    throw Error("ant failed")',
        "  return n * 2",
        "try:",
        "  print(risky(3))",
        "  print(risky(-1))",
        "catch e:",
        '  print("caught", e.message)',
        "class AppError extends Error:",
        "  public constructor(msg: string):",
        "    super(msg)",
        "try:",
        '  throw AppError("bee")',
        "catch e:",
        "  print(e.message.to_upper_case())",
      ),
    );
  });

  it("declines a caught error that is printed whole", () => {
    declines(src("try:", '  throw Error("boom")', "catch e:", "  print(e)"));
  });

  it("declines an error subclass that carries state of its own", () => {
    declines(
      src(
        "class HttpError extends Error:",
        "  public status: int",
        "  public constructor(msg: string, status: int):",
        "    super(msg)",
        "    this.status = status",
        "try:",
        '  throw HttpError("nope", 404)',
        "catch e:",
        "  print(e.message, e.status)",
      ),
    );
  });

  it("declines a program that throws both plain text and errors", () => {
    declines(
      src(
        "fn go(n: int) -> int:",
        "  if n < 0:",
        '    throw "plain"',
        '  throw Error("boom")',
        "try:",
        "  print(go(1))",
        "catch e:",
        "  print(e.message)",
      ),
    );
  });
});

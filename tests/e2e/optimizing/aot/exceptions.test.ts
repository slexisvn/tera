import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative } from "../../../helpers/c-executor.js";
import { cCalls } from "../../../helpers/aot-agreement.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { TERA_EXIT_UNCAUGHT_THROW } from "../../../../src/optimizing/target/faults.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string, backend = "c") {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend });
  expect(program.skipped).toEqual([]);
  return program;
}

const native = cCalls({
  toC: (source: string) => cSource(compile(source)),
  interpret: (source: string, call: string) => interpret(source, call),
});

function interpret(source: string, call: string): unknown {
  return nodeEngine({ typecheck: "off" }).runNative(`${source}\n${call}\n`);
}

function ran(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return runPe(program.files[0]!.contents as Uint8Array);
}

const RISKY = src(
  "fn risky(n: int) -> int:",
  "  if n < 0:",
  '    throw "negative"',
  "  return n * 2",
);

const ACCOUNT = src(
  "class Account:",
  "  public constructor(balance: int):",
  "    this.balance = balance",
  "  public take(amount: int) -> int:",
  "    if amount > this.balance:",
  '      throw "insufficient funds"',
  "    this.balance -= amount",
  "    return this.balance",
);

describe("AOT exceptions", () => {
  itNative("catches a throw raised in the same function", native.matches(
      src(
        "fn go(n: int) -> int:",
        "  try:",
        "    if n < 0:",
        '      throw "negative"',
        "    return n",
        "  catch e:",
        "    return 0",
      ),
      "go",
      [-4],
    ));

  itNative("catches a throw raised by a callee", native.matches(
      src(RISKY, "fn go(n: int) -> int:", "  try:", "    return risky(n)", "  catch e:", "    return -1"),
      "go",
      [-4],
    ));

  itNative("leaves the value of a call that did not throw alone", native.matches(
      src(RISKY, "fn go(n: int) -> int:", "  try:", "    return risky(n)", "  catch e:", "    return -1"),
      "go",
      [21],
    ));

  itNative("carries a throw through a frame that has no handler", native.matches(
      src(
        RISKY,
        "fn middle(n: int) -> int:",
        "  return risky(n) + 1",
        "fn go(n: int) -> int:",
        "  try:",
        "    return middle(n)",
        "  catch e:",
        "    return -1",
      ),
      "go",
      [-4],
    ));

  itNative("keeps the mutation a throwing method made before it threw", native.matches(
      src(
        ACCOUNT,
        "fn go(n: int) -> int:",
        "  account = Account(100)",
        "  try:",
        "    account.take(30)",
        "    account.take(n)",
        "  catch e:",
        "    return account.balance",
        "  return 0",
      ),
      "go",
      [500],
    ));

  itNative("catches once per iteration of a loop", native.matches(
      src(
        RISKY,
        "fn go(n: int) -> int:",
        "  total = 0",
        "  for value of [1, -1, 3]:",
        "    try:",
        "      total = total + risky(value)",
        "    catch e:",
        "      total = total + n",
        "  return total",
      ),
      "go",
      [100],
    ));

  itNative("hands a rethrow to the enclosing handler", native.matches(
      src(
        "fn go(n: int) -> int:",
        "  try:",
        "    try:",
        '      throw "inner"',
        "    catch e:",
        '      throw "outer"',
        "  catch e:",
        "    return n",
        "  return 0",
      ),
      "go",
      [7],
    ));

  itRunsPe("binds the thrown message to the catch variable", () => {
    expect(ran(src("try:", '  throw "boom"', "catch e:", '  print("caught:", e)')).stdout).toBe(
      "caught: boom\n",
    );
  });

  itRunsPe("runs a finalizer on the throwing path before the handler sees it", () => {
    const run = ran(
      src(
        "fn guarded(n: int) -> int:",
        "  try:",
        "    if n < 0:",
        '      throw "bad"',
        "    return n",
        "  finally:",
        '    print("cleanup", n)',
        "try:",
        "  guarded(-1)",
        "catch e:",
        '  print("caught:", e)',
      ),
    );

    expect([run.status, run.stdout]).toEqual([0, "cleanup -1\ncaught: bad\n"]);
  });

  itRunsPe("carries a thrown string the thrower built to the handler", () => {
    const run = ran(
      src(
        "fn bad(n: int) -> int:",
        '  throw "code " + n.to_string()',
        "  return 0",
        "try:",
        "  print(bad(42))",
        "catch e:",
        "  print(e)",
      ),
    );

    expect([run.status, run.stdout]).toEqual([0, "code 42\n"]);
  });

  itRunsPe("declines to keep a caught string across a call that can rebuild it", () => {
    const source = src(
      "fn bad(n: int) -> int:",
      '  throw "code " + n.to_string()',
      "  return 0",
      "fn label(n: int) -> string:",
      '  return "label " + n.to_string()',
      "try:",
      "  print(bad(42))",
      "catch e:",
      "  print(label(1))",
      "  print(e)",
    );

    expect(() =>
      nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
        backend: "x64-windows",
        format: "executable",
      }),
    ).toThrow(/keeps the value it caught across a call to label/);
  });

  itRunsPe("reports a throw no handler is left to take", () => {
    const run = ran(src("try:", '  throw "first"', "catch e:", "  print(e)", 'throw "second"'));

    expect([run.status, run.stdout, run.stderr]).toEqual([
      TERA_EXIT_UNCAUGHT_THROW,
      "first\n",
      "Uncaught second\n",
    ]);
  });
});

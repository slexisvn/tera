import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/index.js";
import { hostEngineOptions } from "../../../src/cli/host.js";
import { main } from "../../../src/cli/main.js";

const src = (...lines: string[]) => lines.join("\n");

type CliRun = {
  readonly status: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
};

async function runCli(...argv: string[]): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => void stdout.push(String(message));
  console.error = (message?: unknown) => void stderr.push(String(message));
  try {
    return { status: await main(argv), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function renders(source: string): string[] {
  const prints: string[] = [];
  const engine = new Engine({ ...hostEngineOptions(), output: (text) => prints.push(String(text)) });
  engine.runNative(source);
  return prints;
}

const DIAMOND = src(
  "signal price = 12.5",
  "signal quantity = 2",
  "signal coupon = 0.0",
  "computed subtotal = price * quantity",
  "computed discount = subtotal * coupon",
  "computed total = subtotal - discount",
  "effect:",
  "  print(subtotal, discount, total)",
  "quantity.set(3)",
  "coupon.set(0.1)",
  "price.update(p => p + 2.5)",
);

describe("reactive cycle diagnostics", () => {
  it("runs examples/reactive.tera to completion without reporting a cycle", async () => {
    const run = await runCli("examples/reactive.tera");

    expect(run.stderr.join("\n")).not.toContain("Reactive cycle detected");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("render subtotal = 45 | discount = 4.5 | total = 40.5 | tax = 3.24");
    expect(run.stdout).toContain("peek total without subscribing = 48");
    expect(run.stdout).toContain("resource state = ready | loading = false");
  });

  it("recomputes a diamond signal chain when the shared dependency changes", () => {
    expect(renders(DIAMOND)).toEqual([
      "25 0 25",
      "37.5 0 37.5",
      "37.5 3.75 33.75",
      "45 4.5 40.5",
    ]);
  });

  it("recomputes a diamond whose downstream computed is pulled before its stale sibling", () => {
    const source = src(
      "signal base = 1",
      "computed doubled = base * 2",
      "computed sum = base + doubled",
      "effect:",
      "  print(sum)",
      "base.set(5)",
      "base.set(9)",
    );

    expect(renders(source)).toEqual(["3", "15", "27"]);
  });

  it("still reports a cycle when an effect writes the signal it reads", () => {
    const engine = new Engine(hostEngineOptions());

    expect(() => engine.runNative(src(
      "signal count = 0",
      "effect:",
      "  count.set(count + 1)",
    ))).toThrow(/Reactive cycle detected/);
  });
});

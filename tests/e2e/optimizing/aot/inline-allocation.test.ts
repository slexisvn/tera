import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import { TERA_CONTEXT } from "../../../../src/optimizing/target/runtime-layout.js";

const src = (...lines: string[]) => lines.join("\n");

const BOX = src(
  "class Box:",
  "  public constructor(v: int):",
  "    this.v = v",
);

function assembly(source: string): string {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "assembly",
  });
  expect(program.skipped).toEqual([]);
  return program.files.map((file) => String(file.contents)).join("\n");
}

function bodyOf(source: string, symbol: string): string {
  const text = assembly(source);
  const start = text.indexOf(`\n${symbol}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(`.size ${symbol}`, start);
  return text.slice(start, end < 0 ? undefined : end);
}

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

const ALLOCATES = src(BOX, "fn make(v: int) -> int:", "  return Box(v).v");

describe("AOT inline allocation", () => {
  it("bumps the cursor in line and keeps the runtime for the overflow", () => {
    const body = bodyOf(ALLOCATES, "make");

    expect(body).toContain(`tera_context+${TERA_CONTEXT.offsetOf("arenaCursor")}(%rip)`);
    expect(body).toContain(`cmpq tera_context+${TERA_CONTEXT.offsetOf("arenaCommitted")}(%rip)`);
    expect(body).toMatch(/ja\s+\.L\w+_alloc_\d+\b/);
    expect(body).toContain("call tera_alloc");
  });

  it("reaches the runtime only from the overflow path", () => {
    const body = bodyOf(ALLOCATES, "make");
    const slow = body.slice(body.search(/^\.L\w+_alloc_\d+:$/m));

    expect(slow).toContain("call tera_alloc");
    expect(body.slice(0, body.search(/^\.L\w+_alloc_\d+:$/m))).not.toContain("call tera_alloc");
  });

  itRunsPe("allocates objects the interpreter agrees with", () => {
    const counted = src(
      BOX,
      "fn total(n: int) -> int:",
      "  total = 0",
      "  i = 0",
      "  while i < n:",
      "    total = total + Box(i % 7).v",
      "    i = i + 1",
      "  return total",
    );
    const expected = nodeEngine({ typecheck: "off" }).runNative(`${counted}\ntotal(300000)\n`);
    const run = runPe(image(src(counted, "print(total(300000))")));

    expect([run.status, run.stdout]).toEqual([0, `${expected}\n`]);
  });
});

import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { hostBackendId } from "../../../../src/optimizing/backends/index.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";

const HOST_TARGET = hostBackendId()!;

const src = (...lines: string[]) => lines.join("\n");

const engine = nodeEngine({ typecheck: "off" });

function reasons(source: string): { x64: string; c: string } {
  const x64 = engine.compileAot(source, { backend: HOST_TARGET });
  const c = engine.compileAot(source);
  return {
    x64: x64.skipped.map((fn) => fn.reason).join("; "),
    c: c.skipped.map((fn) => fn.reason).join("; "),
  };
}

function bothDecline(source: string, expected: string): void {
  const { x64, c } = reasons(source);
  expect(x64).toContain(expected);
  expect(c).toContain(expected);
}

function bothAdmit(source: string): void {
  const { x64, c } = reasons(source);
  expect(x64).toBe("");
  expect(c).toBe("");
}

const MISMATCH = "function returns a value that does not match its return type";

describe("AOT return types agree across every path", () => {
  it("refuses an array returned beside a number", () => {
    expect(() =>
      reasons(src("fn step(flag: bool) -> int[]:", "  if flag:", "    return [1, 2]", "  return 3")),
    ).toThrow("Type 'int' is not assignable to return type 'int[]'");
  });

  it("declines an object returned beside a number", () => {
    bothDecline(
      src("fn step(flag: bool):", "  if flag:", "    return {v: 1}", "  return 3"),
      MISMATCH,
    );
  });

  it("names a reference return the signature left out", () => {
    bothAdmit(src("fn step(flag: bool):", "  if flag:", "    return [1, 2]", "  return [3]"));
  });

  it("declines a return whose paths answer different kinds", () => {
    bothDecline(
      src("fn step(flag: bool):", "  if flag:", "    return [1, 2]", '  return "a"'),
      "returns a string but its return type is not a string",
    );
  });

  it("admits matching reference returns on every path", () => {
    bothAdmit(
      src("fn step(flag: bool) -> int[]:", "  if flag:", "    return [1, 2]", "  return [3]"),
    );
    bothAdmit(
      src("fn step(flag: bool) -> string:", "  if flag:", '    return "a"', '  return "b"'),
    );
  });

  it("admits numeric returns that differ only in width", () => {
    bothAdmit(src("fn step(flag: bool) -> float:", "  if flag:", "    return 1", "  return 2.5"));
  });

  itNative("emits a compilable program for matching reference returns", () => {
    const program = engine.compileAot(
      src(
        "fn pick(flag: bool) -> int[]:",
        "  if flag:",
        "    return [1, 2]",
        "  return [3]",
        "fn head(flag: bool) -> int:",
        "  return pick(flag)[0]",
      ),
    );

    expect(program.skipped).toEqual([]);
    expect(runCFunction(cSource(program), "head", [1])).toBe(1);
    expect(runCFunction(cSource(program), "head", [0])).toBe(3);
  });
});

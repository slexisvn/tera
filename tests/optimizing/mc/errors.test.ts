import { describe, expect, it } from "vitest";
import * as errors from "../../../src/optimizing/mc/errors.js";

type ErrorClass = new (...args: never[]) => Error;

const EXPORTED: readonly (readonly [string, ErrorClass])[] = Object.entries(errors) as never;

const SUBCLASSES = EXPORTED.filter(([name]) => name !== "MachineCodeError");

const CONSTRUCTIONS: readonly (readonly [ErrorClass, readonly (string | number)[]])[] = [
  [errors.UnsupportedInstructionError, ["x64", "vpermilps"]],
  [errors.UnsupportedOperandError, ["x64", "mov", "a memory destination"]],
  [errors.UndefinedSymbolError, ["tera_helper"]],
  [errors.FixupOutOfRangeError, ["rel8", 4096]],
  [errors.UnsupportedRelocationError, ["rel32", "pe", "tera_helper"]],
  [errors.RelaxationLimitError, ["jmp", "rel32"]],
];

const build = ([type, args]: (typeof CONSTRUCTIONS)[number]): Error =>
  new type(...(args as never[]));

describe("the machine-code error hierarchy", () => {
  it("exports a constructor for every failure the assembler can raise", () => {
    expect(EXPORTED.length).toBeGreaterThan(0);
    for (const [, type] of EXPORTED) expect(typeof type).toBe("function");
  });

  it("makes every failure catchable as one MachineCodeError", () => {
    for (const construction of CONSTRUCTIONS) {
      expect(build(construction)).toBeInstanceOf(errors.MachineCodeError);
    }
  });

  it("keeps every failure catchable as a plain Error", () => {
    for (const construction of CONSTRUCTIONS) {
      expect(build(construction)).toBeInstanceOf(Error);
    }
  });

  it("names every error after the class that raised it", () => {
    for (const construction of CONSTRUCTIONS) {
      const raised = build(construction);

      expect(raised.name).toBe(construction[0].name);
    }
  });

  it("covers every exported subclass with a construction", () => {
    const constructed = new Set(CONSTRUCTIONS.map(([type]) => type));

    expect(SUBCLASSES.filter(([, type]) => !constructed.has(type))).toEqual([]);
  });

  it("repeats every operand it was handed in the message it reports", () => {
    for (const construction of CONSTRUCTIONS) {
      const message = build(construction).message;

      for (const operand of construction[1]) expect(message).toContain(String(operand));
    }
  });

  it("keeps the name after being thrown and caught", () => {
    for (const construction of CONSTRUCTIONS) {
      let caught: unknown;
      try {
        throw build(construction);
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).name).toBe(construction[0].name);
      expect(caught).toBeInstanceOf(errors.MachineCodeError);
    }
  });

  it("distinguishes two failures raised by different classes", () => {
    const instruction = new errors.UnsupportedInstructionError("x64", "vpermilps");

    expect(instruction).not.toBeInstanceOf(errors.UnsupportedOperandError);
    expect(instruction).toBeInstanceOf(errors.UnsupportedInstructionError);
  });

  it("carries a stack so a failing encode can be traced back", () => {
    for (const construction of CONSTRUCTIONS) {
      expect(build(construction).stack).toContain(construction[0].name);
    }
  });
});

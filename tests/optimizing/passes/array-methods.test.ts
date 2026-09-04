import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import { printIR } from "../../../src/optimizing/ir/text.js";

const LOWERING = "array-method-lowering";
const TAKER = "only";
const ABSENCE = "Constant [value=undefined]";
const EMPTY_SHIFT_FAULT = "cannot shift an empty array";

const src = (...lines: string[]) => lines.join("\n");

function lowered(source: string): string {
  let taken: string | null = null;
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
    compilerOptions: compilerOptions("speed", {
      passTracer: (record) => {
        if (record.pass === LOWERING && record.graph.name === TAKER) taken = printIR(record.graph);
      },
    }),
  });
  if (taken === null) throw new Error(`${LOWERING} never ran over ${TAKER}`);
  return taken;
}

interface Held {
  readonly element: string;
  readonly value: string;
}

const NUMERIC: Held = { element: "float", value: "2.5" };
const REFERENCE: Held = { element: "string", value: '"a"' };

const taking = (member: string, held: Held, guard: readonly string[]): string =>
  lowered(
    src(
      `fn only(stack: ${held.element}[]) -> int:`,
      ...guard,
      `  print(stack.${member}())`,
      "  return 0",
      `print(only([${held.value}]))`,
    ),
  );

const takes = (...guard: string[]) => taking("pop", NUMERIC, guard).includes(ABSENCE);

const takingTwice = (member: string): string =>
  lowered(
    src(
      "fn only(stack: float[]) -> int:",
      "  if stack.length > 0:",
      `    print(stack.${member}())`,
      `    print(stack.${member}())`,
      "  return 0",
      "print(only([2.5]))",
    ),
  );

describe("lowering a pop the surrounding branch already proved", () => {
  it("takes the element outright after a guard that throws below one", () => {
    expect(takes("  if stack.length < 1:", '    throw "empty"')).toBe(false);
  });

  it("takes the element outright after a guard that throws unless the count is exact", () => {
    expect(takes("  if stack.length != 1:", '    throw "leftover"')).toBe(false);
  });

  it("takes the element outright after a guard that throws unless the array holds some", () => {
    expect(takes("  if stack.length == 0:", '    throw "empty"')).toBe(false);
  });

  it("still answers absence for a pop nothing guarded", () => {
    expect(takes()).toBe(true);
  });

  it("still answers absence when the guard leaves the array empty", () => {
    expect(takes("  if stack.length != 0:", '    throw "not empty"')).toBe(true);
  });

  it("still answers absence for a second pop the same guard cannot cover", () => {
    expect(takingTwice("pop")).toContain(ABSENCE);
  });

  it("still answers absence when something else may shorten the array first", () => {
    const text = lowered(
      src(
        "fn only(stack: float[]) -> int:",
        "  if stack.length > 0:",
        "    stack.splice(0, 1)",
        "    print(stack.pop())",
        "  return 0",
        "print(only([2.5]))",
      ),
    );

    expect(text).toContain(ABSENCE);
  });
});

describe("lowering a shift that may find the array already empty", () => {
  const shifts = (held: Held, ...guard: string[]) => taking("shift", held, guard);
  const PROVES_SOME = ["  if stack.length < 1:", '    throw "empty"'];

  it("joins an absence for a shift nothing proved the array could answer", () => {
    const text = shifts(NUMERIC);

    expect(text).toContain(ABSENCE);
    expect(text).not.toContain(EMPTY_SHIFT_FAULT);
  });

  it("takes the front outright after a guard that proved the array holds some", () => {
    const text = shifts(NUMERIC, ...PROVES_SOME);

    expect(text).not.toContain(ABSENCE);
    expect(text).toContain(EMPTY_SHIFT_FAULT);
  });

  it("takes the front outright when the element is a reference no absence fits", () => {
    const text = shifts(REFERENCE);

    expect(text).not.toContain(ABSENCE);
    expect(text).toContain(EMPTY_SHIFT_FAULT);
  });

  it("still answers absence for a second shift the same guard cannot cover", () => {
    expect(takingTwice("shift")).toContain(ABSENCE);
  });
});

const CALL_SITE = /^\s+v\d+ = GenericCall /m;

function loweredBody(...lines: string[]): string {
  return lowered(src("fn only(xs: int[]) -> int:", ...lines, "print(only([2, 3]))"));
}

describe("lowering a value put at the front of an array", () => {
  it("leaves no generic call for a backend to refuse", () => {
    const text = loweredBody("  xs.unshift(1)", "  return xs.length");

    expect(CALL_SITE.test(text)).toBe(false);
  });

  it("reserves room the way a push does before moving anything", () => {
    const text = loweredBody("  xs.unshift(1)", "  return xs.length");

    expect(text).toContain("ArrayReserve");
  });

  it("moves the elements with a loop that both reads and writes the buffer", () => {
    const text = loweredBody("  xs.unshift(1)", "  return xs.length");

    expect(text).toContain("LoadElement");
    expect(text).toContain("StoreElement");
  });

  it("answers the grown length rather than the call it replaced", () => {
    const text = loweredBody("  return xs.unshift(1)");

    expect(CALL_SITE.test(text)).toBe(false);
    expect(text).toMatch(/Return v\d+/);
    expect(text).toContain("Int32Add");
  });
});

describe("lowering a range taken out of the middle of an array", () => {
  it("leaves no generic call for a backend to refuse", () => {
    const text = loweredBody("  xs.splice(1, 2)", "  return xs.length");

    expect(CALL_SITE.test(text)).toBe(false);
  });

  it("gathers what it removed into an array of its own", () => {
    const text = loweredBody("  xs.splice(1, 2)", "  return xs.length");

    expect(text).toContain("NewObject");
    expect(text).toContain("LoadElement");
    expect(text).toContain("StoreElement");
  });

  it("leaves no generic call for a splice given values to put in their place", () => {
    const text = loweredBody("  xs.splice(1, 0, 9)", "  return xs.length");

    expect(CALL_SITE.test(text)).toBe(false);
  });

  it("reserves room once more for every value it puts in", () => {
    const roomFor = (call: string) =>
      (loweredBody(`  ${call}`, "  return xs.length").match(/ArrayReserve/g) ?? []).length;
    const removing = roomFor("xs.splice(1, 1)");

    expect(roomFor("xs.splice(1, 1, 9)")).toBe(removing + 1);
    expect(roomFor("xs.splice(1, 1, 9, 8)")).toBe(removing + 2);
  });

  it("still gathers what it removed when it also puts values in", () => {
    const text = loweredBody("  print(xs.splice(1, 1, 9))", "  return xs.length");

    expect(CALL_SITE.test(text)).toBe(false);
    expect(text).toContain("NewObject");
  });

  it("leaves a splice whose values arrive spread out of an array alone", () => {
    const text = loweredBody(
      "  ys: int[] = [8, 9]",
      "  xs.splice(1, 1, ...ys)",
      "  return xs.length",
    );

    expect(CALL_SITE.test(text)).toBe(true);
  });
});

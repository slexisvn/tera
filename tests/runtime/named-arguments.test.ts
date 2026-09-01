import { describe, it, expect } from "vitest";
import { acceptsNamedOptions, bindNamedSlots, positionalSlots } from "../../src/runtime/named-arguments.js";
import type { RuntimeFunctionParameterMetadata } from "../../src/core/value/index.js";

const REDUCE: RuntimeFunctionParameterMetadata[] = [
  { name: "axis", type: "int", optional: true },
  { name: "keep", type: "bool", optional: true },
];

const FACTORY: RuntimeFunctionParameterMetadata[] = [
  { name: "shape", type: "int[]" },
  { name: "value", type: "float" },
  { name: "dtype", type: "string", named: true },
];

const REST: RuntimeFunctionParameterMetadata[] = [
  { name: "first", type: "int" },
  { name: "others", type: "int[]", rest: true },
];

const bind = (
  params: RuntimeFunctionParameterMetadata[] | undefined,
  positional: unknown[],
  named: Record<string, unknown>,
) =>
  bindNamedSlots(
    params,
    positional,
    Object.entries(named).map(([name, value]) => ({ name, value })),
    undefined,
  );

describe("positionalSlots", () => {
  it("numbers the positional parameters in declaration order", () => {
    expect(positionalSlots(REDUCE).get("axis")).toBe(0);
    expect(positionalSlots(REDUCE).get("keep")).toBe(1);
  });

  it("accepts the axis/dim synonym in both directions", () => {
    expect(positionalSlots(REDUCE).get("dim")).toBe(0);
    expect(positionalSlots([{ name: "dim" }]).get("axis")).toBe(0);
  });

  it("accepts the camelCase spelling of a snake_case parameter", () => {
    expect(positionalSlots([{ name: "step_size" }]).get("stepSize")).toBe(0);
  });

  it("leaves named-only and rest parameters out of the slots", () => {
    expect(positionalSlots(FACTORY).has("dtype")).toBe(false);
    expect(positionalSlots(REST).has("others")).toBe(false);
  });

  it("skips named-only parameters without consuming a slot", () => {
    const slots = positionalSlots([{ name: "a" }, { name: "opt", named: true }, { name: "b" }]);
    expect(slots.get("b")).toBe(1);
  });

  it("reuses the slot map for the same parameter list", () => {
    expect(positionalSlots(REDUCE)).toBe(positionalSlots(REDUCE));
  });
});

describe("acceptsNamedOptions", () => {
  it("treats an undeclared signature as one that takes options", () => {
    expect(acceptsNamedOptions(undefined)).toBe(true);
  });

  it("treats a fully positional signature as one that takes none", () => {
    expect(acceptsNamedOptions(REDUCE)).toBe(false);
  });

  it("treats a named-only or rest parameter as an options bag", () => {
    expect(acceptsNamedOptions(FACTORY)).toBe(true);
    expect(acceptsNamedOptions(REST)).toBe(true);
  });
});

describe("bindNamedSlots", () => {
  it("places a named argument in the slot its parameter declares", () => {
    expect(bind(REDUCE, [], { axis: 1 })).toEqual({ values: [1], rest: [] });
  });

  it("binds through the axis/dim synonym", () => {
    expect(bind(REDUCE, [], { dim: 1 })).toEqual({ values: [1], rest: [] });
  });

  it("pads the slots a caller skipped", () => {
    expect(bind(REDUCE, [], { keep: true })).toEqual({ values: [undefined, true], rest: [] });
  });

  it("keeps a named-only parameter out of the positional list", () => {
    const bound = bind(FACTORY, [[2, 2]], { value: 9, dtype: "f32" });
    expect(bound.values).toEqual([[2, 2], 9]);
    expect(bound.rest).toEqual([{ name: "dtype", value: "f32" }]);
  });

  it("leaves an unknown name for the callee to read as an option", () => {
    expect(bind(REDUCE, [], { unknown: 1 })).toEqual({
      values: [],
      rest: [{ name: "unknown", value: 1 }],
    });
  });

  it("never overwrites an argument the caller already passed positionally", () => {
    expect(bind(REDUCE, [0], { axis: 1 })).toEqual({
      values: [0],
      rest: [{ name: "axis", value: 1 }],
    });
  });

  it("passes the arguments through when the callee declares no parameters", () => {
    expect(bind(undefined, [1], { axis: 1 })).toEqual({
      values: [1],
      rest: [{ name: "axis", value: 1 }],
    });
  });

  it("passes the arguments through when there is nothing named to bind", () => {
    expect(bind(REDUCE, [1, true], {})).toEqual({ values: [1, true], rest: [] });
  });
});

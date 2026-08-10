import { beforeEach, describe, expect, it } from "vitest";
import {
  EFFECT_CALL,
  EFFECT_READ,
  IR_CALL_BUILTIN,
  irCallBuiltin,
  irConstant,
  irRequiresFrameState,
  resetIRNodeIds,
} from "../../../src/optimizing/ir/index.js";

beforeEach(() => resetIRNodeIds());

const args = (count: number) =>
  Array.from({ length: count }, (_, index) => irConstant(index));

describe("irCallBuiltin", () => {
  it("names the builtin and wires every argument as an input", () => {
    const inputs = args(2);
    const node = irCallBuiltin("string.char_code_at", inputs);

    expect(node.type).toBe(IR_CALL_BUILTIN);
    expect(node.props.name).toBe("string.char_code_at");
    expect(node.inputs).toEqual(inputs);
  });

  it("keeps argCount in step with the inputs for every arity", () => {
    for (const count of [0, 1, 2, 5]) {
      const node = irCallBuiltin("owner.method", args(count));
      expect(node.props.argCount).toBe(count);
      expect(node.props.argCount).toBe(node.inputs.length);
    }
  });

  it("registers the call as a use of each argument", () => {
    const inputs = args(2);
    const node = irCallBuiltin("owner.method", inputs);

    for (const input of inputs) expect(input.uses).toContain(node);
  });

  it("defaults to a call effect", () => {
    expect(irCallBuiltin("owner.method", []).effectKind).toBe(EFFECT_CALL);
  });

  it("lets metadata declare a lighter effect", () => {
    const node = irCallBuiltin("owner.method", [], {
      effectKind: EFFECT_READ,
      pure: true,
    });

    expect(node.effectKind).toBe(EFFECT_READ);
    expect(node.props.pure).toBe(true);
  });

  it("does not let metadata forge the name or the arity", () => {
    const node = irCallBuiltin("owner.method", args(1), {
      name: "other.method",
      argCount: 99,
    });

    expect(node.props.name).toBe("owner.method");
    expect(node.props.argCount).toBe(1);
  });

  it("still requires a frame state so deoptimization can rebuild the frame", () => {
    expect(irRequiresFrameState(irCallBuiltin("owner.method", []))).toBe(true);
  });
});

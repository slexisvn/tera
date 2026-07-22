import { describe, it, expect } from "vitest";
import {
  applyRelational,
  hasRelationalOverload,
  RELATIONAL_BY_SYMBOL,
  type RelationalOverload,
} from "../../src/runtime/operators.js";
import { createJSObject } from "../../src/objects/heap/factory.js";
import {
  getPayload,
  isBool,
  mkFunction,
  mkObject,
  mkSmi,
  mkString,
  type TaggedValue,
} from "../../src/core/value/index.js";

type Invocation = { method: string; receiver: TaggedValue; args: TaggedValue[] };

function interpreterSpy() {
  const calls: Invocation[] = [];
  const labels = new Map<TaggedValue, string>();
  return {
    calls,
    label(fn: TaggedValue, method: string) {
      labels.set(fn, method);
    },
    callFunctionValue(fn: TaggedValue, args: TaggedValue[], receiver: TaggedValue): TaggedValue {
      calls.push({ method: labels.get(fn) ?? "?", receiver, args });
      return mkString(`${labels.get(fn)}-result`);
    },
  };
}

function comparable(methods: RelationalOverload[]) {
  const spy = interpreterSpy();
  const object = createJSObject();
  for (const method of methods) {
    const fn = mkFunction({ name: method, call: () => mkString("unused") });
    spy.label(fn, method);
    object.setProperty(method, fn);
  }
  return { value: mkObject(object), spy };
}

describe("relational operator overloading", () => {
  describe("RELATIONAL_BY_SYMBOL", () => {
    it("maps each relational operator to its method name", () => {
      expect(RELATIONAL_BY_SYMBOL["<"]).toBe("lt");
      expect(RELATIONAL_BY_SYMBOL[">"]).toBe("gt");
      expect(RELATIONAL_BY_SYMBOL["<="]).toBe("le");
      expect(RELATIONAL_BY_SYMBOL[">="]).toBe("ge");
    });

    it("does not map equality, which must keep identity semantics", () => {
      expect(RELATIONAL_BY_SYMBOL["=="]).toBeUndefined();
      expect(RELATIONAL_BY_SYMBOL["!="]).toBeUndefined();
    });
  });

  describe("applyRelational", () => {
    it("dispatches to the method on the left operand", () => {
      const { value, spy } = comparable(["gt"]);
      const result = applyRelational("gt", value, mkSmi(2), spy);

      expect(getPayload(result as never)).toBe("gt-result");
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.method).toBe("gt");
      expect(spy.calls[0]!.receiver).toBe(value);
      expect(getPayload(spy.calls[0]!.args[0] as never)).toBe(2);
    });

    it("reflects to the mirrored method when only the right operand overloads", () => {
      const { value, spy } = comparable(["gt"]);
      const result = applyRelational("lt", mkSmi(2), value, spy);

      expect(getPayload(result as never)).toBe("gt-result");
      expect(spy.calls[0]!.method).toBe("gt");
      expect(spy.calls[0]!.receiver).toBe(value);
      expect(getPayload(spy.calls[0]!.args[0] as never)).toBe(2);
    });

    it("mirrors every relational operator to its opposite", () => {
      const pairs: Array<[RelationalOverload, RelationalOverload]> = [
        ["lt", "gt"],
        ["gt", "lt"],
        ["le", "ge"],
        ["ge", "le"],
      ];
      for (const [operator, mirrored] of pairs) {
        const { value, spy } = comparable([mirrored]);
        applyRelational(operator, mkSmi(1), value, spy);
        expect(spy.calls[0]!.method).toBe(mirrored);
      }
    });

    it("prefers the left operand when both sides overload", () => {
      const left = comparable(["gt"]);
      const right = comparable(["lt"]);
      applyRelational("gt", left.value, right.value, left.spy);

      expect(left.spy.calls).toHaveLength(1);
      expect(right.spy.calls).toHaveLength(0);
    });

    it("falls back to primitive comparison when neither side overloads", () => {
      const spy = interpreterSpy();

      expect(getPayload(applyRelational("lt", mkSmi(1), mkSmi(2), spy) as never)).toBe(true);
      expect(getPayload(applyRelational("gt", mkSmi(1), mkSmi(2), spy) as never)).toBe(false);
      expect(getPayload(applyRelational("le", mkSmi(2), mkSmi(2), spy) as never)).toBe(true);
      expect(getPayload(applyRelational("ge", mkSmi(1), mkSmi(2), spy) as never)).toBe(false);
      expect(spy.calls).toHaveLength(0);
    });

    it("compares strings through the primitive fallback", () => {
      const spy = interpreterSpy();
      const result = applyRelational("gt", mkString("b"), mkString("a"), spy);

      expect(isBool(result)).toBe(true);
      expect(getPayload(result as never)).toBe(true);
    });

    it("ignores an unrelated method on the operand", () => {
      const { value, spy } = comparable(["le"]);
      const result = applyRelational("gt", value, mkSmi(2), spy);

      expect(spy.calls).toHaveLength(0);
      expect(isBool(result)).toBe(true);
    });
  });

  describe("hasRelationalOverload", () => {
    it("detects an overload on the left operand", () => {
      const { value, spy } = comparable(["gt"]);
      expect(hasRelationalOverload("gt", value, mkSmi(1), spy)).toBe(true);
    });

    it("detects a mirrored overload on the right operand", () => {
      const { value, spy } = comparable(["gt"]);
      expect(hasRelationalOverload("lt", mkSmi(1), value, spy)).toBe(true);
    });

    it("is false when the mirrored method is absent", () => {
      const { value, spy } = comparable(["lt"]);
      expect(hasRelationalOverload("lt", mkSmi(1), value, spy)).toBe(false);
    });

    it("is false for two primitives", () => {
      const spy = interpreterSpy();
      expect(hasRelationalOverload("lt", mkSmi(1), mkSmi(2), spy)).toBe(false);
      expect(spy.calls).toHaveLength(0);
    });
  });
});

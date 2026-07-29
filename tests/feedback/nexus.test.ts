import { describe, it, expect } from "vitest";
import { FeedbackNexus, FEEDBACK_HINT_GENERIC, FEEDBACK_HINT_MONOMORPHIC, FEEDBACK_HINT_POLYMORPHIC, FEEDBACK_HINT_MEGAMORPHIC } from "../../src/feedback/nexus/index.js";
import { FeedbackVector, FeedbackSlot, FEEDBACK_PROPERTY, FEEDBACK_BINARY_OP, FEEDBACK_UNARY_OP, FEEDBACK_CALL, FEEDBACK_BRANCH } from "../../src/feedback/vector/index.js";

function makeNexus(slotCount) {
  const vec = new FeedbackVector(slotCount);
  return { nexus: new FeedbackNexus(vec), vec };
}

describe("FeedbackNexus", () => {
  describe("binaryOp", () => {
    it("returns generic for uninitialized slot", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_BINARY_OP);
      const info = nexus.binaryOp(0);
      expect(info.state).toBe("uninitialized");
    });

    it("returns observed input type for smi+smi", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_BINARY_OP);
      vec.getSlot(0).recordBinaryOp("smi", "smi");
      const info = nexus.binaryOp(0);
      expect(info.inputType).toBeDefined();
      expect(info.stable).toBe(true);
    });

    it("returns null slot info for missing slot", () => {
      const { nexus } = makeNexus(1);
      const info = nexus.binaryOp(0);
      expect(info.slot).toBeNull();
    });
  });

  describe("unaryOp", () => {
    it("returns observed type", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_UNARY_OP);
      vec.getSlot(0).recordUnaryOp("smi");
      const info = nexus.unaryOp(0);
      expect(info.inputType).toBeDefined();
      expect(info.state).toBe("monomorphic");
    });
  });

  describe("property", () => {
    it("returns monomorphic hint with map/offset", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(42, 8, 3, 1);
      const info = nexus.property(0);
      expect(info.kind).toBe(FEEDBACK_HINT_MONOMORPHIC);
      expect(info.map).toBe(42);
      expect(info.offset).toBe(8);
      expect(info.mapVersion).toBe(3);
      expect(info.protoDepth).toBe(1);
      expect(info.stable).toBe(true);
    });

    it("returns polymorphic hint with arrays", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0, 10);
      vec.getSlot(0).recordPropertyAccess(2, 4, 20);
      const info = nexus.property(0);
      expect(info.kind).toBe(FEEDBACK_HINT_POLYMORPHIC);
      expect(info.maps).toEqual([1, 2]);
      expect(info.offsets).toEqual([0, 4]);
    });

    it("returns megamorphic hint", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      for (let i = 1; i <= 5; i++) vec.getSlot(0).recordPropertyAccess(i, i);
      const info = nexus.property(0);
      expect(info.kind).toBe(FEEDBACK_HINT_MEGAMORPHIC);
      expect(info.stable).toBe(false);
    });

    it("returns generic for null slot", () => {
      const { nexus } = makeNexus(1);
      const info = nexus.property(0);
      expect(info.kind).toBe(FEEDBACK_HINT_GENERIC);
    });
  });

  describe("elements", () => {
    it("returns monomorphic with elements kind", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordArrayAccess(true, true, "PACKED_SMI");
      const info = nexus.elements(0);
      expect(info.kind).toBe(FEEDBACK_HINT_MONOMORPHIC);
      expect(info.elementsKind).toBe("PACKED_SMI");
      expect(info.arrayAccess).toBe(true);
    });

    it("returns megamorphic for non-array access", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordArrayAccess(false, true);
      const info = nexus.elements(0);
      expect(info.kind).toBe(FEEDBACK_HINT_MEGAMORPHIC);
    });

    it("tracks length access", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordArrayLengthAccess(true, "PACKED_SMI");
      const info = nexus.elements(0);
      expect(info.lengthAccess).toBe(true);
    });
  });

  describe("call", () => {
    it("returns monomorphic call info", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_CALL);
      vec.getSlot(0).recordCallTarget("print", null, 2);
      const info = nexus.call(0);
      expect(info.kind).toBe(FEEDBACK_HINT_MONOMORPHIC);
      expect(info.target).toBe("builtin:print");
      expect(info.argCount).toBe(2);
      expect(info.frequency).toBe(1);
    });

    it("returns polymorphic with multiple targets", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_CALL);
      const fn1 = { id: "f1", version: 1 };
      const fn2 = { id: "f2", version: 1 };
      vec.getSlot(0).recordCallTarget("a", fn1, 1);
      vec.getSlot(0).recordCallTarget("b", fn2, 1);
      const info = nexus.call(0);
      expect(info.kind).toBe(FEEDBACK_HINT_POLYMORPHIC);
      expect(info.frequency).toBe(2);
    });

    it("returns generic for null slot", () => {
      const { nexus } = makeNexus(1);
      const info = nexus.call(0);
      expect(info.kind).toBe(FEEDBACK_HINT_GENERIC);
      expect(info.target).toBeNull();
      expect(info.frequency).toBe(0);
    });

    it("returns megamorphic info", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_CALL);
      for (let i = 0; i < 5; i++)
        vec.getSlot(0).recordCallTarget(`fn${i}`, { id: `id${i}`, version: 1 }, 0);
      const info = nexus.call(0);
      expect(info.kind).toBe(FEEDBACK_HINT_MEGAMORPHIC);
      expect(info.stable).toBe(false);
    });
  });

  describe("branch", () => {
    it("returns bias from slot", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_BRANCH);
      for (let i = 0; i < 20; i++) vec.getSlot(0).recordBranch(true);
      vec.getSlot(0).recordBranch(false);
      const info = nexus.branch(0);
      expect(info.bias).toBe("likely-true");
    });

    it("returns unknown for null slot", () => {
      const { nexus } = makeNexus(1);
      const info = nexus.branch(0);
      expect(info.bias).toBe("unknown");
    });
  });

  describe("returnType", () => {
    it("returns smi type for smi-only returns", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_CALL);
      vec.getSlot(0).recordReturnType("smi");
      const t = nexus.returnType(0);
      expect(t).toBeDefined();
    });

    it("returns number type for mixed smi/double", () => {
      const { nexus, vec } = makeNexus(1);
      vec.initSlot(0, FEEDBACK_CALL);
      vec.getSlot(0).recordReturnType("smi");
      vec.getSlot(0).recordReturnType("double");
      const t = nexus.returnType(0);
      expect(t).toBeDefined();
    });
  });

  describe("negative index", () => {
    it("getSlot returns null for negative index", () => {
      const { nexus } = makeNexus(1);
      expect(nexus.getSlot(-1)).toBeNull();
    });
  });
});

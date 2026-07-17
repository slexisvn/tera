import { describe, it, expect, beforeEach } from "vitest";
import {
  FeedbackSlot,
  FeedbackVector,
  FEEDBACK_PROPERTY,
  FEEDBACK_BINARY_OP,
  FEEDBACK_UNARY_OP,
  FEEDBACK_CALL,
  FEEDBACK_BRANCH,
  IC_UNINITIALIZED,
  IC_MONOMORPHIC,
  IC_POLYMORPHIC,
  IC_MEGAMORPHIC,
  DEFAULT_LOOP_BUDGET,
} from "../../src/feedback/vector/index.js";

describe("FeedbackSlot", () => {
  describe("property access lattice transitions", () => {
    let slot;
    beforeEach(() => { slot = new FeedbackSlot(FEEDBACK_PROPERTY); });

    it("transitions uninitialized -> monomorphic on first record", () => {
      slot.recordPropertyAccess(1, 0, 1);
      expect(slot.icState).toBe(IC_MONOMORPHIC);
      expect(slot.maps).toEqual([1]);
    });

    it("stays monomorphic on same hidden class", () => {
      slot.recordPropertyAccess(1, 0, 1);
      slot.recordPropertyAccess(1, 0, 1);
      expect(slot.icState).toBe(IC_MONOMORPHIC);
      expect(slot.maps).toHaveLength(1);
    });

    it("transitions monomorphic -> polymorphic on second class", () => {
      slot.recordPropertyAccess(1, 0);
      slot.recordPropertyAccess(2, 4);
      expect(slot.icState).toBe(IC_POLYMORPHIC);
      expect(slot.maps).toEqual([1, 2]);
      expect(slot.offsets).toEqual([0, 4]);
    });

    it("transitions to megamorphic after >4 unique classes", () => {
      for (let i = 1; i <= 5; i++) slot.recordPropertyAccess(i, i * 2);
      expect(slot.icState).toBe(IC_MEGAMORPHIC);
    });

    it("updates version/offset for existing class without transition", () => {
      slot.recordPropertyAccess(1, 0, 1);
      slot.recordPropertyAccess(1, 8, 2);
      expect(slot.icState).toBe(IC_MONOMORPHIC);
      expect(slot.offsets[0]).toBe(8);
      expect(slot.mapVersions[0]).toBe(2);
    });

    it("tracks protoDepth", () => {
      slot.recordPropertyAccess(1, 0, 1, 3);
      expect(slot.getMonomorphicProtoDepth()).toBe(3);
    });
  });

  describe("monomorphic queries", () => {
    it("returns map/offset/version for monomorphic", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(42, 8, 3);
      expect(slot.getMonomorphicMap()).toBe(42);
      expect(slot.getMonomorphicOffset()).toBe(8);
      expect(slot.getMonomorphicMapVersion()).toBe(3);
    });

    it("returns null when not monomorphic", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0);
      slot.recordPropertyAccess(2, 4);
      expect(slot.getMonomorphicMap()).toBeNull();
      expect(slot.getMonomorphicOffset()).toBeNull();
    });
  });

  describe("polymorphic queries", () => {
    it("returns arrays for polymorphic state", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0, 10);
      slot.recordPropertyAccess(2, 4, 20);
      expect(slot.getPolymorphicMaps()).toEqual([1, 2]);
      expect(slot.getPolymorphicOffsets()).toEqual([0, 4]);
      expect(slot.getPolymorphicMapVersions()).toEqual([10, 20]);
    });

    it("returns null when not polymorphic", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0);
      expect(slot.getPolymorphicMaps()).toBeNull();
    });
  });

  describe("binary op feedback", () => {
    it("tracks lhs and rhs types separately", () => {
      const slot = new FeedbackSlot(FEEDBACK_BINARY_OP);
      slot.recordBinaryOp("smi", "double");
      expect(slot.lhsTypeCounts.get("smi")).toBe(1);
      expect(slot.rhsTypeCounts.get("double")).toBe(1);
      expect(slot.typeCounts.get("smi|double")).toBe(1);
    });

    it("transitions through lattice on new type combos", () => {
      const slot = new FeedbackSlot(FEEDBACK_BINARY_OP);
      slot.recordBinaryOp("smi", "smi");
      expect(slot.icState).toBe(IC_MONOMORPHIC);
      slot.recordBinaryOp("double", "smi");
      expect(slot.icState).toBe(IC_POLYMORPHIC);
    });

    it("goes megamorphic after >4 unique combos", () => {
      const slot = new FeedbackSlot(FEEDBACK_BINARY_OP);
      const tags = ["smi", "double", "string", "boolean", "null"];
      for (let i = 0; i < 5; i++) slot.recordBinaryOp(tags[i], "smi");
      expect(slot.icState).toBe(IC_MEGAMORPHIC);
    });

    it("getDominantType returns most frequent", () => {
      const slot = new FeedbackSlot(FEEDBACK_BINARY_OP);
      slot.recordBinaryOp("smi", "smi");
      slot.recordBinaryOp("smi", "smi");
      slot.recordBinaryOp("double", "double");
      expect(slot.getDominantType()).toBe("smi|smi");
    });
  });

  describe("unary op feedback", () => {
    it("tracks operand types", () => {
      const slot = new FeedbackSlot(FEEDBACK_UNARY_OP);
      slot.recordUnaryOp("smi");
      slot.recordUnaryOp("smi");
      expect(slot.typeCounts.get("smi")).toBe(2);
      expect(slot.icState).toBe(IC_MONOMORPHIC);
    });

    it("transitions on new types", () => {
      const slot = new FeedbackSlot(FEEDBACK_UNARY_OP);
      slot.recordUnaryOp("smi");
      slot.recordUnaryOp("string");
      expect(slot.icState).toBe(IC_POLYMORPHIC);
    });
  });

  describe("branch feedback", () => {
    it("returns likely-true when heavily biased", () => {
      const slot = new FeedbackSlot(FEEDBACK_BRANCH);
      for (let i = 0; i < 20; i++) slot.recordBranch(true);
      slot.recordBranch(false);
      expect(slot.getBranchBias()).toBe("likely-true");
    });

    it("returns likely-false when heavily biased", () => {
      const slot = new FeedbackSlot(FEEDBACK_BRANCH);
      slot.recordBranch(true);
      for (let i = 0; i < 20; i++) slot.recordBranch(false);
      expect(slot.getBranchBias()).toBe("likely-false");
    });

    it("returns mixed when balanced", () => {
      const slot = new FeedbackSlot(FEEDBACK_BRANCH);
      for (let i = 0; i < 5; i++) {
        slot.recordBranch(true);
        slot.recordBranch(false);
      }
      expect(slot.getBranchBias()).toBe("mixed");
    });

    it("returns unknown when no records", () => {
      const slot = new FeedbackSlot(FEEDBACK_BRANCH);
      expect(slot.getBranchBias()).toBe("unknown");
    });
  });

  describe("return type feedback", () => {
    it("hasOnlySmiReturns when all smi", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordReturnType("smi");
      slot.recordReturnType("smi");
      expect(slot.hasOnlySmiReturns()).toBe(true);
      expect(slot.hasOnlyNumberReturns()).toBe(true);
    });

    it("hasOnlyNumberReturns with mixed smi/double", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordReturnType("smi");
      slot.recordReturnType("double");
      expect(slot.hasOnlySmiReturns()).toBe(false);
      expect(slot.hasOnlyNumberReturns()).toBe(true);
    });

    it("neither when string present", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordReturnType("smi");
      slot.recordReturnType("string");
      expect(slot.hasOnlySmiReturns()).toBe(false);
      expect(slot.hasOnlyNumberReturns()).toBe(false);
    });
  });

  describe("call target feedback", () => {
    it("monomorphic with single builtin target", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordCallTarget("print", null, 1);
      expect(slot.icState).toBe(IC_MONOMORPHIC);
      expect(slot.getMonomorphicCallTarget()).toBe("builtin:print");
      expect(slot.getMonomorphicCallArgCount()).toBe(1);
      expect(slot.totalCallCount).toBe(1);
    });

    it("monomorphic with compiled function", () => {
      const fn = { id: "fn1", version: 2 };
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordCallTarget("myFunc", fn, 2);
      expect(slot.getMonomorphicCallTarget()).toBe("fn1");
      expect(slot.getMonomorphicCallTargetRef()).toBe(fn);
      expect(slot.getMonomorphicCallTargetVersion()).toBe(2);
    });

    it("polymorphic with multiple targets", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      const fn1 = { id: "f1", version: 1 };
      const fn2 = { id: "f2", version: 1 };
      slot.recordCallTarget("a", fn1, 1);
      slot.recordCallTarget("b", fn2, 1);
      expect(slot.icState).toBe(IC_POLYMORPHIC);
      expect(slot.callTargetRef).toBeNull();
    });

    it("megamorphic after >4 unique targets", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      for (let i = 0; i < 5; i++) {
        slot.recordCallTarget(`fn${i}`, { id: `id${i}`, version: 1 }, 0);
      }
      expect(slot.icState).toBe(IC_MEGAMORPHIC);
    });

    it("tracks receiver map for method calls", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordCallTarget("method", null, 0, "map1", 1);
      expect(slot.getMonomorphicReceiverMap()).toBe("map1");
    });

    it("accumulates call count for same target", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordCallTarget("print", null, 1);
      slot.recordCallTarget("print", null, 1);
      slot.recordCallTarget("print", null, 1);
      expect(slot.totalCallCount).toBe(3);
      expect(slot.icState).toBe(IC_MONOMORPHIC);
    });
  });

  describe("array access feedback", () => {
    it("monomorphic array integer access", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordArrayAccess(true, true, "PACKED_SMI");
      expect(slot.icState).toBe(IC_MONOMORPHIC);
      expect(slot.hasOnlyArrayAccesses()).toBe(true);
      expect(slot.getMonomorphicElementsKind()).toBe("PACKED_SMI");
    });

    it("megamorphic on non-array access", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordArrayAccess(false, true, null);
      expect(slot.icState).toBe(IC_MEGAMORPHIC);
    });

    it("megamorphic on non-integer index", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordArrayAccess(true, false, null);
      expect(slot.icState).toBe(IC_MEGAMORPHIC);
    });

    it("polymorphic with multiple elements kinds", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordArrayAccess(true, true, "PACKED_SMI");
      slot.recordArrayAccess(true, true, "PACKED_DOUBLE");
      expect(slot.icState).toBe(IC_POLYMORPHIC);
      expect(slot.getObservedElementsKinds()).toEqual(["PACKED_SMI", "PACKED_DOUBLE"]);
    });

    it("tracks array length accesses separately", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordArrayLengthAccess(true, "PACKED_SMI");
      expect(slot.hasOnlyArrayLengthAccesses()).toBe(true);
      expect(slot.hasOnlyArrayAccesses()).toBe(false);
    });

    it("array length non-array goes megamorphic", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordArrayLengthAccess(false);
      expect(slot.icState).toBe(IC_MEGAMORPHIC);
    });
  });

  describe("stability", () => {
    it("becomes stable after 50 records without transition", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0, 1);
      for (let i = 0; i < 50; i++) slot.recordPropertyAccess(1, 0, 1);
      expect(slot.isStable).toBe(true);
    });

    it("resets stability on state transition", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0);
      for (let i = 0; i < 50; i++) slot.recordPropertyAccess(1, 0);
      expect(slot.isStable).toBe(true);
      slot.recordPropertyAccess(2, 4);
      expect(slot.isStable).toBe(false);
      expect(slot.stableSinceCount).toBe(0);
    });
  });

  describe("lattice is forward-only", () => {
    it("cannot go backwards from polymorphic to monomorphic", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0);
      slot.recordPropertyAccess(2, 4);
      expect(slot.icState).toBe(IC_POLYMORPHIC);
      for (let i = 0; i < 100; i++) slot.recordPropertyAccess(1, 0);
      expect(slot.icState).toBe(IC_POLYMORPHIC);
    });
  });

  describe("allocation site", () => {
    it("tracks unique hidden class ids", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordAllocationSite(1);
      slot.recordAllocationSite(2);
      slot.recordAllocationSite(1);
      expect(slot.allocationSiteHCs.size).toBe(2);
    });
  });

  describe("inline decisions circular buffer", () => {
    it("keeps max 16 decisions", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      for (let i = 0; i < 20; i++) slot.recordInlineDecision("inline", `r${i}`);
      expect(slot.inlineDecisions).toHaveLength(16);
      expect(slot.inlineDecisions[0].reason).toBe("r4");
    });
  });

  describe("serialize/deserialize roundtrip", () => {
    it("preserves property feedback", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0, 5, 2);
      slot.recordPropertyAccess(2, 4, 6, 0);
      const restored = FeedbackSlot.deserialize(slot.serialize());
      expect(restored.icState).toBe(IC_POLYMORPHIC);
      expect(restored.maps).toEqual([1, 2]);
      expect(restored.offsets).toEqual([0, 4]);
      expect(restored.mapVersions).toEqual([5, 6]);
      expect(restored.protoDepths).toEqual([2, 0]);
    });

    it("preserves binary op feedback", () => {
      const slot = new FeedbackSlot(FEEDBACK_BINARY_OP);
      slot.recordBinaryOp("smi", "double");
      const restored = FeedbackSlot.deserialize(slot.serialize());
      expect(restored.lhsTypeCounts.get("smi")).toBe(1);
      expect(restored.rhsTypeCounts.get("double")).toBe(1);
    });

    it("preserves call target feedback", () => {
      const slot = new FeedbackSlot(FEEDBACK_CALL);
      slot.recordCallTarget("print", null, 2);
      const restored = FeedbackSlot.deserialize(slot.serialize());
      expect(restored.totalCallCount).toBe(1);
      expect(restored.getMonomorphicCallTarget()).toBe("builtin:print");
    });
  });

  describe("reset", () => {
    it("clears all feedback to uninitialized", () => {
      const slot = new FeedbackSlot(FEEDBACK_PROPERTY);
      slot.recordPropertyAccess(1, 0);
      slot.recordPropertyAccess(2, 4);
      slot.reset();
      expect(slot.icState).toBe(IC_UNINITIALIZED);
      expect(slot.maps).toHaveLength(0);
      expect(slot.totalRecordCount).toBe(0);
      expect(slot.isStable).toBe(false);
    });
  });
});

describe("FeedbackVector", () => {
  describe("slot management", () => {
    it("lazily initializes slots", () => {
      const vec = new FeedbackVector(4);
      expect(vec.getSlot(0)).toBeNull();
      vec.initSlot(0, FEEDBACK_PROPERTY);
      expect(vec.getSlot(0)).toBeInstanceOf(FeedbackSlot);
      expect(vec.getSlot(0).kind).toBe(FEEDBACK_PROPERTY);
    });

    it("does not overwrite existing slot", () => {
      const vec = new FeedbackVector(4);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0);
      vec.initSlot(0, FEEDBACK_BINARY_OP);
      expect(vec.getSlot(0).kind).toBe(FEEDBACK_PROPERTY);
      expect(vec.getSlot(0).maps).toHaveLength(1);
    });

    it("resetSlot clears individual slot", () => {
      const vec = new FeedbackVector(2);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.initSlot(1, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0);
      vec.getSlot(1).recordPropertyAccess(2, 4);
      vec.resetSlot(0);
      expect(vec.getSlot(0).icState).toBe(IC_UNINITIALIZED);
      expect(vec.getSlot(1).icState).toBe(IC_MONOMORPHIC);
    });

    it("resetAll clears all slots and loop budget", () => {
      const vec = new FeedbackVector(2);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0);
      vec.decrementLoopBudget(500);
      vec.resetAll();
      expect(vec.getSlot(0).icState).toBe(IC_UNINITIALIZED);
      expect(vec.loopBudget).toBe(DEFAULT_LOOP_BUDGET);
    });
  });

  describe("loop budget", () => {
    it("decrements and returns false while positive", () => {
      const vec = new FeedbackVector(1);
      expect(vec.decrementLoopBudget(100)).toBe(false);
      expect(vec.loopBudget).toBe(900);
    });

    it("returns true when budget exhausted", () => {
      const vec = new FeedbackVector(1);
      expect(vec.decrementLoopBudget(1000)).toBe(true);
      expect(vec.loopBudgetExhausted).toBe(true);
    });

    it("only fires exhaustion once", () => {
      const vec = new FeedbackVector(1);
      vec.decrementLoopBudget(1000);
      expect(vec.decrementLoopBudget(1)).toBe(false);
    });

    it("resetLoopBudget restores budget", () => {
      const vec = new FeedbackVector(1);
      vec.decrementLoopBudget(1000);
      vec.resetLoopBudget();
      expect(vec.loopBudget).toBe(DEFAULT_LOOP_BUDGET);
      expect(vec.loopBudgetExhausted).toBe(false);
    });
  });

  describe("getSummaryStats", () => {
    it("aggregates slot states", () => {
      const vec = new FeedbackVector(3);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.initSlot(1, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0);
      vec.getSlot(1).recordPropertyAccess(1, 0);
      vec.getSlot(1).recordPropertyAccess(2, 4);
      const stats = vec.getSummaryStats();
      expect(stats.totalSlots).toBe(3);
      expect(stats.initializedSlots).toBe(2);
      expect(stats.monomorphicSlots).toBe(1);
      expect(stats.polymorphicSlots).toBe(1);
    });
  });

  describe("getSlotsNeedingRefresh", () => {
    it("flags megamorphic and unstable slots", () => {
      const vec = new FeedbackVector(3);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.initSlot(1, FEEDBACK_PROPERTY);
      vec.initSlot(2, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0);
      for (let i = 1; i <= 5; i++) vec.getSlot(1).recordPropertyAccess(i, i);
      const needing = vec.getSlotsNeedingRefresh();
      expect(needing).toContain(0);
      expect(needing).toContain(1);
      expect(needing).not.toContain(2);
    });
  });

  describe("isSettled", () => {
    it("true when stable with enough records", () => {
      const vec = new FeedbackVector(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      const slot = vec.getSlot(0);
      slot.recordPropertyAccess(1, 0);
      for (let i = 0; i < 55; i++) slot.recordPropertyAccess(1, 0);
      expect(vec.isSettled(0)).toBe(true);
    });

    it("false when not enough records", () => {
      const vec = new FeedbackVector(1);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0);
      expect(vec.isSettled(0)).toBe(false);
    });
  });

  describe("serialize/deserialize roundtrip", () => {
    it("preserves vector with slots", () => {
      const vec = new FeedbackVector(2);
      vec.initSlot(0, FEEDBACK_PROPERTY);
      vec.getSlot(0).recordPropertyAccess(1, 0, 5);
      vec.decrementLoopBudget(300);
      const restored = FeedbackVector.deserialize(vec.serialize());
      expect(restored.slotCount()).toBe(2);
      expect(restored.getSlot(0).maps).toEqual([1]);
      expect(restored.loopBudget).toBe(700);
      expect(restored.getSlot(1)).toBeNull();
    });
  });

  describe("fromCompiledFunction", () => {
    it("creates vector with correct slot count", () => {
      const vec = FeedbackVector.fromCompiledFunction({ feedbackSlotCount: 8 });
      expect(vec.slotCount()).toBe(8);
    });
  });
});

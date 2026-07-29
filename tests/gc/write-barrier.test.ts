import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bindWriteBarrierGC, storeBarrier, storeBarrierForTaggedValue } from "../../src/gc/write-barrier.js";
import { RememberedSet } from "../../src/gc/remembered-set.js";
import { COLOR_WHITE } from "../../src/gc/incremental-marker.js";
import { mkObject } from "../../src/core/value/index.js";
import { createJSObject } from "../../src/objects/heap/factory.js";

function makeGCObj(gen) {
  return {
    gcHeader: { generation: gen, color: COLOR_WHITE },
  };
}

function makeMockGC() {
  const gc = {
    rememberedSet: new RememberedSet(),
    _incrementalActive: false,
    _barriers: [],
    isIncrementalMarkingActive() {
      return this._incrementalActive;
    },
    incrementalWriteBarrier(holder, newRef) {
      this._barriers.push({ holder, newRef });
    },
  };
  return gc;
}

describe("write-barrier", () => {
  let gc;

  beforeEach(() => {
    gc = makeMockGC();
    bindWriteBarrierGC(gc);
  });

  afterEach(() => {
    bindWriteBarrierGC(null);
  });

  describe("storeBarrier", () => {
    it("records old→young reference in remembered set", () => {
      const holder = makeGCObj("old");
      const newRef = makeGCObj("young");
      storeBarrier(holder, newRef);
      expect(gc.rememberedSet.has(holder)).toBe(true);
    });

    it("does not record young→young or young→old references", () => {
      storeBarrier(makeGCObj("young"), makeGCObj("young"));
      storeBarrier(makeGCObj("young"), makeGCObj("old"));
      storeBarrier(makeGCObj("old"), makeGCObj("old"));
      expect(gc.rememberedSet.size).toBe(0);
    });

    it("triggers incremental write barrier when marking is active", () => {
      gc._incrementalActive = true;
      const holder = makeGCObj("old");
      const newRef = makeGCObj("old");
      storeBarrier(holder, newRef);
      expect(gc._barriers).toHaveLength(1);
      expect(gc._barriers[0].holder).toBe(holder);
    });

    it("skips everything when gc is not bound", () => {
      bindWriteBarrierGC(null);
      storeBarrier(makeGCObj("old"), makeGCObj("young"));
    });

    it("handles null/missing gcHeader gracefully", () => {
      storeBarrier(null, makeGCObj("young"));
      storeBarrier(makeGCObj("old"), null);
      storeBarrier({}, makeGCObj("young"));
      expect(gc.rememberedSet.size).toBe(0);
    });
  });

  describe("storeBarrierForTaggedValue", () => {
    it("extracts payload and delegates to storeBarrier for old→young", () => {
      const holder = makeGCObj("old");
      const innerJSObj = createJSObject();
      innerJSObj.gcHeader = { generation: "young", color: COLOR_WHITE };
      const taggedValue = mkObject(innerJSObj);
      storeBarrierForTaggedValue(holder, taggedValue);
      expect(gc.rememberedSet.has(holder)).toBe(true);
    });

    it("skips non-object tagged values", () => {
      const holder = makeGCObj("old");
      storeBarrierForTaggedValue(holder, 42);
      expect(gc.rememberedSet.size).toBe(0);
    });
  });
});

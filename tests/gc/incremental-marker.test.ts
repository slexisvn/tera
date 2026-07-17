import { describe, it, expect } from "vitest";
import {
  IncrementalMarker,
  COLOR_WHITE,
  COLOR_GREY,
  COLOR_BLACK,
} from "../../src/gc/incremental-marker.js";

function makeGCObj(id, refs = []) {
  return {
    id,
    gcHeader: { color: COLOR_WHITE },
    visitReferences(cb) {
      for (const r of refs) cb(r);
    },
  };
}

describe("IncrementalMarker", () => {
  describe("tri-color marking", () => {
    it("marks reachable graph BLACK through transitive references", () => {
      const c = makeGCObj("c");
      const b = makeGCObj("b", [c]);
      const a = makeGCObj("a", [b]);

      const marker = new IncrementalMarker();
      marker.startMarking([a]);
      expect(a.gcHeader.color).toBe(COLOR_GREY);

      marker.finishMarking();
      expect(a.gcHeader.color).toBe(COLOR_BLACK);
      expect(b.gcHeader.color).toBe(COLOR_BLACK);
      expect(c.gcHeader.color).toBe(COLOR_BLACK);
      expect(marker.totalMarked).toBe(3);
    });

    it("unreachable objects remain WHITE", () => {
      const reachable = makeGCObj("reach");
      const unreachable = makeGCObj("unreach");
      const marker = new IncrementalMarker();
      marker.startMarking([reachable]);
      marker.finishMarking();
      expect(reachable.gcHeader.color).toBe(COLOR_BLACK);
      expect(unreachable.gcHeader.color).toBe(COLOR_WHITE);
    });

    it("handles cycles without infinite loop", () => {
      const a = makeGCObj("a");
      const b = makeGCObj("b");
      a.visitReferences = (cb) => cb(b);
      b.visitReferences = (cb) => cb(a);

      const marker = new IncrementalMarker();
      marker.startMarking([a]);
      marker.finishMarking();
      expect(a.gcHeader.color).toBe(COLOR_BLACK);
      expect(b.gcHeader.color).toBe(COLOR_BLACK);
      expect(marker.totalMarked).toBe(2);
    });
  });

  describe("incremental stepping", () => {
    it("step processes a subset and returns true while work remains", () => {
      const chain = [];
      for (let i = 0; i < 50; i++) chain.push(makeGCObj(i));
      for (let i = 0; i < chain.length - 1; i++) {
        const next = chain[i + 1];
        chain[i].visitReferences = (cb) => cb(next);
      }

      const marker = new IncrementalMarker();
      marker.startMarking([chain[0]]);

      const moreWork = marker.step(1000);
      expect(marker.stepsRun).toBe(1);
      expect(marker.totalMarked).toBeGreaterThan(0);
    });

    it("step returns false and sets markingComplete when done", () => {
      const obj = makeGCObj("single");
      const marker = new IncrementalMarker();
      marker.startMarking([obj]);

      while (marker.step(1000)) {}
      expect(marker.markingComplete).toBe(true);
      expect(marker.isMarking()).toBe(false);
    });

    it("step on inactive marker returns false", () => {
      const marker = new IncrementalMarker();
      expect(marker.step()).toBe(false);
    });
  });

  describe("write barrier (SATB + Dijkstra)", () => {
    it("SATB: pushes old WHITE ref when holder is BLACK", () => {
      const marker = new IncrementalMarker();
      const holder = makeGCObj("holder");
      const oldRef = makeGCObj("old");
      const newRef = makeGCObj("new");
      holder.gcHeader.color = COLOR_BLACK;

      marker.marking = true;
      marker.markingComplete = false;
      marker.writeBarrier(holder, newRef, oldRef);

      expect(oldRef.gcHeader.color).toBe(COLOR_GREY);
      expect(newRef.gcHeader.color).toBe(COLOR_GREY);
      expect(marker.worklist).toContain(oldRef);
      expect(marker.worklist).toContain(newRef);
    });

    it("skips barrier when holder is not BLACK", () => {
      const marker = new IncrementalMarker();
      const holder = makeGCObj("holder");
      const oldRef = makeGCObj("old");
      holder.gcHeader.color = COLOR_GREY;

      marker.marking = true;
      marker.markingComplete = false;
      marker.writeBarrier(holder, null, oldRef);
      expect(oldRef.gcHeader.color).toBe(COLOR_WHITE);
    });

    it("skips barrier when not actively marking", () => {
      const marker = new IncrementalMarker();
      const holder = makeGCObj("holder");
      const newRef = makeGCObj("new");
      holder.gcHeader.color = COLOR_BLACK;

      marker.writeBarrier(holder, newRef, null);
      expect(newRef.gcHeader.color).toBe(COLOR_WHITE);
    });

    it("does not push already-BLACK refs", () => {
      const marker = new IncrementalMarker();
      const holder = makeGCObj("holder");
      const oldRef = makeGCObj("old");
      holder.gcHeader.color = COLOR_BLACK;
      oldRef.gcHeader.color = COLOR_BLACK;

      marker.marking = true;
      marker.markingComplete = false;
      marker.writeBarrier(holder, null, oldRef);
      expect(marker.worklist).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const marker = new IncrementalMarker();
      marker.startMarking([makeGCObj("a")]);
      marker.finishMarking();
      marker.reset();
      expect(marker.marking).toBe(false);
      expect(marker.markingComplete).toBe(false);
      expect(marker.totalMarked).toBe(0);
      expect(marker.stepsRun).toBe(0);
      expect(marker.worklist).toHaveLength(0);
    });
  });
});

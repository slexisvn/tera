import { describe, it, expect, beforeEach } from "vitest";
import { ExecutionProfile } from "../../src/feedback/profile/index.js";

describe("ExecutionProfile", () => {
  let profile;
  beforeEach(() => { profile = new ExecutionProfile(); });

  describe("recordExecution", () => {
    it("accumulates total calls and time", () => {
      profile.recordExecution(5);
      profile.recordExecution(10);
      expect(profile.totalCalls).toBe(2);
      expect(profile.totalTimeMs).toBe(15);
    });

    it("computes EMA — first call sets directly, subsequent weighted", () => {
      profile.recordExecution(10);
      expect(profile.emaTimeMs).toBe(10);
      profile.recordExecution(20);
      expect(profile.emaTimeMs).toBeCloseTo(0.3 * 20 + 0.7 * 10);
    });

    it("keeps circular buffer of recent times (max 32)", () => {
      for (let i = 0; i < 40; i++) profile.recordExecution(i);
      expect(profile.recentTimes).toHaveLength(32);
      expect(profile.recentTimes[0]).toBe(8);
    });

    it("increments callsSinceLastICTransition", () => {
      profile.recordExecution(1);
      profile.recordExecution(1);
      expect(profile.callsSinceLastICTransition).toBe(2);
    });
  });

  describe("avgTimeMs", () => {
    it("returns 0 with no calls", () => {
      expect(profile.avgTimeMs).toBe(0);
    });

    it("computes average", () => {
      profile.recordExecution(10);
      profile.recordExecution(20);
      expect(profile.avgTimeMs).toBe(15);
    });
  });

  describe("recordDeopt", () => {
    it("tracks count and reasons", () => {
      profile.recordDeopt("map-changed");
      profile.recordDeopt("type-mismatch");
      expect(profile.deoptCount).toBe(2);
      expect(profile.deoptReasons).toEqual(["map-changed", "type-mismatch"]);
    });

    it("keeps max 10 reasons", () => {
      for (let i = 0; i < 15; i++) profile.recordDeopt(`reason${i}`);
      expect(profile.deoptReasons).toHaveLength(10);
      expect(profile.deoptReasons[0]).toBe("reason5");
    });
  });

  describe("timeSinceLastDeopt", () => {
    it("returns Infinity when never deopted", () => {
      expect(profile.timeSinceLastDeopt()).toBe(Infinity);
    });

    it("returns elapsed ms after deopt", () => {
      profile.recordDeopt("test");
      expect(profile.timeSinceLastDeopt()).toBeLessThan(100);
    });
  });

  describe("recordICTransition", () => {
    it("resets callsSinceLastICTransition", () => {
      profile.recordExecution(1);
      profile.recordExecution(1);
      profile.recordExecution(1);
      profile.recordICTransition();
      expect(profile.callsSinceLastICTransition).toBe(0);
      expect(profile.icTransitionCount).toBe(1);
    });
  });

  describe("isStable", () => {
    it("false before 50 calls since last IC transition", () => {
      for (let i = 0; i < 49; i++) profile.recordExecution(1);
      expect(profile.isStable()).toBe(false);
    });

    it("true after 50 calls since last IC transition", () => {
      for (let i = 0; i < 50; i++) profile.recordExecution(1);
      expect(profile.isStable()).toBe(true);
    });

    it("resets on IC transition", () => {
      for (let i = 0; i < 50; i++) profile.recordExecution(1);
      expect(profile.isStable()).toBe(true);
      profile.recordICTransition();
      expect(profile.isStable()).toBe(false);
    });
  });

  describe("recordLoopIterations", () => {
    it("accumulates loop count", () => {
      profile.recordLoopIterations(100);
      profile.recordLoopIterations(50);
      expect(profile.loopIterations).toBe(150);
    });
  });

  describe("hotness", () => {
    it("combines frequency, EMA, and loop weight", () => {
      profile.recordExecution(10);
      const freq = profile.callFrequency;
      const ema = profile.emaTimeMs;
      expect(profile.hotness(0)).toBe(freq * ema);
      expect(profile.hotness(2)).toBe(freq * ema * 3);
    });
  });
});

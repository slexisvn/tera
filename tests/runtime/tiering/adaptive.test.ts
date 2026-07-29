import { describe, it, expect } from "vitest";
import { AdaptiveTieringPolicy } from "../../../src/runtime/tiering/adaptive.js";
import { createTieringPolicy, DEFAULT_TIERING_POLICY } from "../../../src/runtime/tiering/policy.js";

describe("AdaptiveTieringPolicy", () => {
  describe("profile management", () => {
    it("getProfile returns stable reference per function", () => {
      const policy = new AdaptiveTieringPolicy();
      const fn = { name: "test" };
      const p1 = policy.getProfile(fn);
      const p2 = policy.getProfile(fn);
      expect(p1).toBe(p2);
    });

    it("different functions get different profiles", () => {
      const policy = new AdaptiveTieringPolicy();
      const fn1 = { name: "a" };
      const fn2 = { name: "b" };
      expect(policy.getProfile(fn1)).not.toBe(policy.getProfile(fn2));
    });

    it("primitive keys are stringified", () => {
      const policy = new AdaptiveTieringPolicy();
      const p1 = policy.getProfile("myFunc");
      const p2 = policy.getProfile("myFunc");
      expect(p1).toBe(p2);
    });
  });

  describe("shouldOptimize", () => {
    it("returns false when invocation count below jitThreshold", () => {
      const policy = new AdaptiveTieringPolicy({ jitThreshold: 50 });
      const fn = { name: "test", invocationCount: 10 };
      expect(policy.shouldOptimize(fn)).toBe(false);
    });

    it("returns true when invocation count meets threshold", () => {
      const policy = new AdaptiveTieringPolicy({ jitThreshold: 5 });
      const fn = { name: "test", invocationCount: 10 };
      expect(policy.shouldOptimize(fn)).toBe(true);
    });

    it("returns false if already optimized", () => {
      const policy = new AdaptiveTieringPolicy({ jitThreshold: 5 });
      const fn = { name: "test", invocationCount: 100, optimizedCode: {} };
      expect(policy.shouldOptimize(fn)).toBe(false);
    });

    it("returns false if optimization disabled", () => {
      const policy = new AdaptiveTieringPolicy({ jitThreshold: 5 });
      const fn = { name: "test", invocationCount: 100, disableOptimization: true };
      expect(policy.shouldOptimize(fn)).toBe(false);
    });

    it("returns false during cooldown period", () => {
      const policy = new AdaptiveTieringPolicy({ jitThreshold: 5 });
      const fn = {
        name: "test",
        invocationCount: 100,
        optimizationCooldownUntil: Date.now() + 100000,
      };
      expect(policy.shouldOptimize(fn)).toBe(false);
    });

    it("returns false after too many compile failures", () => {
      const policy = new AdaptiveTieringPolicy({ jitThreshold: 5 });
      const fn = { name: "test", invocationCount: 100 };
      for (let i = 0; i < 4; i++) {
        policy.recordCompileFailure(fn, "test");
      }
      expect(policy.shouldOptimize(fn)).toBe(false);
    });

    it("compile success resets failure count", () => {
      const policy = new AdaptiveTieringPolicy({ jitThreshold: 5 });
      const fn = { name: "test", invocationCount: 100 };
      policy.recordCompileFailure(fn, "test");
      policy.recordCompileFailure(fn, "test");
      policy.recordCompileSuccess(fn);
      const profile = policy.getProfile(fn);
      expect(profile.compileFailureCount).toBe(0);
    });
  });

  describe("shouldBaselineCompile", () => {
    it("returns true when invocationCount >= baselineThreshold and no baseline", () => {
      const policy = new AdaptiveTieringPolicy({ baselineThreshold: 10 });
      const fn = { name: "test", invocationCount: 15 };
      expect(policy.shouldBaselineCompile(fn)).toBe(true);
    });

    it("returns false if baselineCode already exists", () => {
      const policy = new AdaptiveTieringPolicy({ baselineThreshold: 10 });
      const fn = { name: "test", invocationCount: 15, baselineCode: {} };
      expect(policy.shouldBaselineCompile(fn)).toBe(false);
    });

    it("returns false below threshold", () => {
      const policy = new AdaptiveTieringPolicy({ baselineThreshold: 10 });
      const fn = { name: "test", invocationCount: 5 };
      expect(policy.shouldBaselineCompile(fn)).toBe(false);
    });
  });

  describe("deopt recording", () => {
    it("recordDeopt clears optimizedCode and sets cooldown", () => {
      const policy = new AdaptiveTieringPolicy();
      const fn = { name: "test", optimizedCode: {} };
      policy.recordDeopt(fn, "type-mismatch");
      expect(fn.optimizedCode).toBeNull();
      expect(fn.optimizationCooldownUntil).toBeGreaterThan(Date.now());
    });

    it("multiple deopts increase cooldown exponentially", () => {
      const policy = new AdaptiveTieringPolicy();
      const fn = { name: "test", optimizedCode: {} };
      policy.recordDeopt(fn, "reason1");
      const cooldown1 = fn.optimizationCooldownUntil;
      fn.optimizedCode = {};
      policy.recordDeopt(fn, "reason2");
      const cooldown2 = fn.optimizationCooldownUntil;
      expect(cooldown2 - Date.now()).toBeGreaterThan(cooldown1 - Date.now());
    });

    it("deopt count is tracked in profile", () => {
      const policy = new AdaptiveTieringPolicy();
      const fn = { name: "test", optimizedCode: {} };
      policy.recordDeopt(fn, "r1");
      fn.optimizedCode = {};
      policy.recordDeopt(fn, "r2");
      expect(policy.getProfile(fn).deoptCount).toBe(2);
    });
  });

  describe("OSR", () => {
    it("shouldOSR returns false without optimized OSR entry", () => {
      const policy = new AdaptiveTieringPolicy({ loopOsrThreshold: 10 });
      const fn = { name: "test", invocationCount: 100 };
      expect(policy.shouldOSR(fn, 1000)).toBe(false);
    });

    it("getOSRUrgency increases with loop count", () => {
      const policy = new AdaptiveTieringPolicy();
      const fn = { name: "test" };
      policy.recordExecution(fn, 10);
      const u1 = policy.getOSRUrgency(fn, 10);
      const u2 = policy.getOSRUrgency(fn, 100);
      expect(u2).toBeGreaterThan(u1);
    });
  });

  describe("compilation pressure", () => {
    it("notifyCompilationStart/End adjusts pressure", () => {
      const policy = new AdaptiveTieringPolicy();
      expect(policy.compilationPressure).toBe(0);
      policy.notifyCompilationStart();
      policy.notifyCompilationStart();
      expect(policy.compilationPressure).toBe(2);
      policy.notifyCompilationEnd();
      expect(policy.compilationPressure).toBe(1.5);
    });

    it("pressure caps at 10", () => {
      const policy = new AdaptiveTieringPolicy();
      for (let i = 0; i < 20; i++) policy.notifyCompilationStart();
      expect(policy.compilationPressure).toBe(10);
    });

    it("pressure floors at 0", () => {
      const policy = new AdaptiveTieringPolicy();
      for (let i = 0; i < 5; i++) policy.notifyCompilationEnd();
      expect(policy.compilationPressure).toBe(0);
    });
  });

  describe("getProfileStats", () => {
    it("returns comprehensive stats object", () => {
      const policy = new AdaptiveTieringPolicy();
      const fn = { name: "test" };
      policy.recordExecution(fn, 5);
      policy.recordExecution(fn, 10);
      const stats = policy.getProfileStats(fn);
      expect(stats.totalCalls).toBe(2);
      expect(stats).toHaveProperty("avgTimeMs");
      expect(stats).toHaveProperty("emaTimeMs");
      expect(stats).toHaveProperty("deoptCount");
      expect(stats).toHaveProperty("isStable");
      expect(stats).toHaveProperty("hotness");
    });
  });
});

describe("createTieringPolicy", () => {
  it("returns frozen defaults with no args", () => {
    const policy = createTieringPolicy();
    expect(policy.baselineThreshold).toBe(DEFAULT_TIERING_POLICY.baselineThreshold);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("overrides merge into defaults", () => {
    const policy = createTieringPolicy({ jitThreshold: 200 });
    expect(policy.jitThreshold).toBe(200);
    expect(policy.baselineThreshold).toBe(DEFAULT_TIERING_POLICY.baselineThreshold);
  });

  it("'adaptive' mode creates AdaptiveTieringPolicy", () => {
    const policy = createTieringPolicy("adaptive");
    expect(policy).toBeInstanceOf(AdaptiveTieringPolicy);
  });

  it("{ mode: 'adaptive' } creates AdaptiveTieringPolicy with overrides", () => {
    const policy = createTieringPolicy({ mode: "adaptive", jitThreshold: 77 });
    expect(policy).toBeInstanceOf(AdaptiveTieringPolicy);
    expect(policy.jitThreshold).toBe(77);
  });
});

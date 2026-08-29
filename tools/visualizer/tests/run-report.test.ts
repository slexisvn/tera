import { describe, expect, it } from "vitest";
import { brokeInvariant, statusOf } from "../src/services/run-report";
import type { RunResult } from "../src/types/stage";
import { stageFor } from "./stage";

const CLEAN: RunResult = {
  stages: [stageFor({ id: "licm" }), stageFor({ id: "gvn" })],
  events: [],
  dropped: {},
  output: [],
  outputDropped: 0,
  shapes: [],
  error: null,
  runError: null,
  elapsedMs: 12,
};

const BROKEN: RunResult = {
  ...CLEAN,
  stages: [
    stageFor({ id: "licm" }),
    stageFor({ id: "gvn", failed: true, verification: ["v3 is used before it is defined"] }),
  ],
};

function state(result: RunResult, over: { stale?: boolean; verified?: boolean } = {}) {
  return { result, busy: false, hasRun: true, stale: false, verified: false, ...over };
}

describe("counting broken invariants", () => {
  it("counts only the stages the verifier complained about", () => {
    expect(brokeInvariant(CLEAN)).toBe(0);
    expect(brokeInvariant(BROKEN)).toBe(1);
  });
});

describe("the run status", () => {
  it("says nothing about invariants when verification was not asked for", () => {
    expect(statusOf(state(CLEAN)).text).toBe("2 stages · 12ms");
  });

  it("confirms the invariants held, so a clean verify run is not silent", () => {
    const status = statusOf(state(CLEAN, { verified: true }));

    expect(status.text).toBe("2 stages · 12ms · invariants held");
    expect(status.tone).toBe("ok");
  });

  it("names how many passes broke an invariant and reads as a failure", () => {
    const status = statusOf(state(BROKEN, { verified: true }));

    expect(status.text).toBe("2 stages · 12ms · 1 broke an invariant");
    expect(status.tone).toBe("failed");
  });

  it("still reports a broken invariant over the out-of-date note", () => {
    const status = statusOf(state(BROKEN, { verified: true, stale: true }));

    expect(status.text).toBe("2 stages · 12ms · 1 broke an invariant · out of date");
    expect(status.tone).toBe("failed");
  });

  it("keeps the stale wording when the invariants held", () => {
    const status = statusOf(state(CLEAN, { verified: true, stale: true }));

    expect(status.text).toBe("2 stages · 12ms · invariants held · out of date");
    expect(status.tone).toBe("stale");
  });
});

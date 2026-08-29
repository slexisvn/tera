import { describe, expect, it } from "vitest";
import { comparePin, hashOf, keysOf, pinOf, withoutTexts } from "../src/services/pinned-run";
import type { RunResult, Stage } from "../src/types/stage";
import { stageFor } from "./stage";

function run(stages: readonly Stage[]): RunResult {
  return {
    stages,
    events: [],
    dropped: {},
    output: [],
    outputDropped: 0,
    shapes: [],
    error: null,
    runError: null,
    elapsedMs: 0,
  };
}

const BEFORE = [
  stageFor({ id: "m/0", title: "licm", passName: "licm", owner: "drive", text: "v1 = Constant" }),
  stageFor({ id: "m/1", title: "gvn", passName: "gvn", owner: "drive", text: "v2 = Int32Add" }),
];

describe("pinning a run", () => {
  it("keys a stage by what it is, not by the ordinal in the list", () => {
    const keys = [...keysOf(BEFORE).keys()];

    expect(keys).toEqual(["middle-end/drive/licm#0", "middle-end/drive/gvn#0"]);
  });

  it("tells two runs of the same pass on the same function apart", () => {
    const twice = [
      stageFor({ id: "m/0", title: "gvn", passName: "gvn", owner: "drive" }),
      stageFor({ id: "m/1", title: "gvn", passName: "gvn", owner: "drive" }),
    ];

    expect([...keysOf(twice).keys()]).toEqual([
      "middle-end/drive/gvn#0",
      "middle-end/drive/gvn#1",
    ]);
  });

  it("leaves the executed-graph copy out of the pin", () => {
    const withExecuted = [...BEFORE, stageFor({ id: "e/drive", group: "executed", owner: "drive" })];

    expect(pinOf(run(withExecuted), "req").stages).toHaveLength(2);
  });

  it("reports nothing when the same compile is pinned and compared", () => {
    const report = comparePin(pinOf(run(BEFORE), "req"), BEFORE);

    expect(report.rows).toEqual([]);
    expect(report.totals.same).toBe(2);
  });

  it("shows both sides of a stage the compiler now writes differently", () => {
    const after = [
      BEFORE[0]!,
      stageFor({ id: "m/1", title: "gvn", passName: "gvn", owner: "drive", text: "v2 = Int32Sub" }),
    ];

    const report = comparePin(pinOf(run(BEFORE), "req"), after);

    expect(report.totals.changed).toBe(1);
    expect(report.rows[0]!.before).toBe("v2 = Int32Add");
    expect(report.rows[0]!.after).toBe("v2 = Int32Sub");
    expect(report.rows[0]!.stageId).toBe("m/1");
  });

  it("counts a stage that stopped running as gone and a new one as new", () => {
    const after = [
      BEFORE[0]!,
      stageFor({ id: "m/9", title: "sccp", passName: "sccp", owner: "drive", text: "v3 = Phi" }),
    ];

    const report = comparePin(pinOf(run(BEFORE), "req"), after);

    expect(report.totals.removed).toBe(1);
    expect(report.totals.added).toBe(1);
    expect(report.rows.map((entry) => entry.kind).sort()).toEqual(["added", "removed"]);
  });

  it("hashes the same text to the same number and different text apart", () => {
    expect(hashOf("v1 = Constant")).toBe(hashOf("v1 = Constant"));
    expect(hashOf("v1 = Constant")).not.toBe(hashOf("v1 = Constants"));
  });

  it("drops every text and says so when the pin will not fit", () => {
    const lean = withoutTexts(pinOf(run(BEFORE), "req"));

    expect(lean.stages.every((stage) => stage.text === null)).toBe(true);
    expect(lean.withoutText).toBe(lean.stages.length);
    expect(lean.request).toBe("req");
  });

  it("still tells a rewritten stage from a new one without the pinned text", () => {
    const after = [
      BEFORE[0]!,
      stageFor({ id: "m/1", title: "gvn", passName: "gvn", owner: "drive", text: "v2 = Int32Sub" }),
    ];

    const report = comparePin(withoutTexts(pinOf(run(BEFORE), "req")), after);

    expect(report.totals.changed).toBe(1);
    expect(report.totals.added).toBe(0);
    expect(report.rows[0]!.kind).toBe("changed");
    expect(report.rows[0]!.before).toBeNull();
  });
});

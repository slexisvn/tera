import { describe, expect, it } from "vitest";
import { costOf } from "../src/services/pass-cost";
import { stageFor } from "./stage";

describe("compile cost", () => {
  it("reports nothing when no pass was timed", () => {
    const report = costOf([stageFor({ id: "frontend/tokens", elapsedMs: 0 })]);

    expect(report).toEqual({ measured: 0, total: 0, wasted: 0, idle: 0, slowest: [] });
  });

  it("adds up only the passes that carry a measurement", () => {
    const report = costOf([
      stageFor({ id: "a", elapsedMs: 2 }),
      stageFor({ id: "b", elapsedMs: 3 }),
      stageFor({ id: "frontend", elapsedMs: 0 }),
    ]);

    expect(report.measured).toBe(2);
    expect(report.total).toBe(5);
  });

  it("counts time spent by passes that changed nothing as wasted", () => {
    const report = costOf([
      stageFor({ id: "worked", elapsedMs: 4, changed: true }),
      stageFor({ id: "looked", elapsedMs: 6, changed: false }),
    ]);

    expect(report.wasted).toBe(6);
    expect(report.idle).toBe(1);
  });

  it("leaves out a pass the bisect skipped, since it never ran", () => {
    const report = costOf([
      stageFor({ id: "ran", elapsedMs: 4 }),
      stageFor({ id: "skipped", elapsedMs: 9, skipped: true }),
    ]);

    expect(report.measured).toBe(1);
    expect(report.total).toBe(4);
  });

  it("lists the slowest passes first and keeps only as many as asked", () => {
    const report = costOf(
      [
        stageFor({ id: "quick", title: "gvn", elapsedMs: 1 }),
        stageFor({ id: "slow", title: "licm", elapsedMs: 9 }),
        stageFor({ id: "middling", title: "sccp", elapsedMs: 5 }),
      ],
      2,
    );

    expect(report.slowest.map((entry) => entry.title)).toEqual(["licm", "sccp"]);
  });
});

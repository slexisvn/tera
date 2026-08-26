import { describe, expect, it } from "vitest";
import {
  RemarkRecorder,
  REMARK_BUDGET,
} from "../../../src/optimizing/infra/pass-remarks.js";

const node = (id: number) => ({ id });

describe("RemarkRecorder", () => {
  it("drops everything recorded while no pass scope is open", () => {
    const recorder = new RemarkRecorder();
    recorder.missed(node(1), "nobody is listening");
    expect(recorder.listening).toBe(false);
    expect(recorder.close()).toEqual([]);
  });

  it("tags each remark with the pass that was running when it was recorded", () => {
    const recorder = new RemarkRecorder();
    recorder.open("escape-analysis");
    recorder.missed(node(7), "the allocation escapes");
    const first = recorder.close();

    recorder.open("load-elimination");
    recorder.applied(node(9), "forwarded the load");
    const second = recorder.close();

    expect(first).toEqual([
      { kind: "missed", pass: "escape-analysis", node: 7, message: "the allocation escapes" },
    ]);
    expect(second).toEqual([
      { kind: "applied", pass: "load-elimination", node: 9, message: "forwarded the load" },
    ]);
  });

  it("records a remark with no node when the decision is about the whole pass", () => {
    const recorder = new RemarkRecorder();
    recorder.open("if-conversion");
    recorder.analysis(null, "budget is zero");
    expect(recorder.close()).toEqual([
      { kind: "analysis", pass: "if-conversion", node: null, message: "budget is zero" },
    ]);
  });

  it("keeps one copy when the same decision is reached about the same node twice", () => {
    const recorder = new RemarkRecorder();
    recorder.open("checks");
    recorder.missed(node(3), "index range unknown");
    recorder.missed(node(3), "index range unknown");
    expect(recorder.close()).toHaveLength(1);
  });

  it("separates remarks that differ only in node, kind or message", () => {
    const recorder = new RemarkRecorder();
    recorder.open("checks");
    recorder.missed(node(3), "index range unknown");
    recorder.missed(node(4), "index range unknown");
    recorder.applied(node(3), "index range unknown");
    recorder.missed(node(3), "length unknown");
    expect(recorder.close()).toHaveLength(4);
  });

  it("stops at the budget and says how many it left out", () => {
    const recorder = new RemarkRecorder();
    recorder.open("checks");
    for (let at = 0; at < REMARK_BUDGET + 5; at++) {
      recorder.missed(node(at), `decision ${at}`);
    }
    const recorded = recorder.close();
    expect(recorded).toHaveLength(REMARK_BUDGET + 1);
    expect(recorded[REMARK_BUDGET]).toEqual({
      kind: "analysis",
      pass: "checks",
      node: null,
      message: "5 further remarks were not recorded",
    });
  });

  it("adds no overflow note when the pass stayed inside the budget", () => {
    const recorder = new RemarkRecorder();
    recorder.open("checks");
    for (let at = 0; at < REMARK_BUDGET; at++) recorder.missed(node(at), `decision ${at}`);
    const recorded = recorder.close();
    expect(recorded).toHaveLength(REMARK_BUDGET);
    expect(recorded.some((remark) => remark.message.includes("not recorded"))).toBe(false);
  });

  it("starts empty again after close, so one pass cannot inherit another's remarks", () => {
    const recorder = new RemarkRecorder();
    recorder.open("first");
    recorder.missed(node(1), "something");
    recorder.close();
    recorder.open("second");
    expect(recorder.close()).toEqual([]);
  });

  it("gives a remark to the innermost pass when a stage runs a pipeline inside itself", () => {
    const recorder = new RemarkRecorder();
    recorder.open("module-inlining");
    recorder.applied(node(1), "inlined add");
    recorder.open("sccp");
    recorder.applied(node(2), "folded a constant");
    const inner = recorder.close();
    const outer = recorder.close();

    expect(inner.map((remark) => remark.pass)).toEqual(["sccp"]);
    expect(outer.map((remark) => remark.pass)).toEqual(["module-inlining"]);
  });

  it("keeps recording into the outer stage after the inner pipeline finishes", () => {
    const recorder = new RemarkRecorder();
    recorder.open("module-inlining");
    recorder.open("sccp");
    recorder.close();
    recorder.missed(node(3), "declined after the inner run");

    expect(recorder.depth).toBe(1);
    expect(recorder.close()).toEqual([
      {
        kind: "missed",
        pass: "module-inlining",
        node: 3,
        message: "declined after the inner run",
      },
    ]);
  });

  it("closes back to nothing listening once every scope is popped", () => {
    const recorder = new RemarkRecorder();
    recorder.open("outer");
    recorder.open("inner");
    recorder.close();
    recorder.close();

    expect(recorder.listening).toBe(false);
    expect(recorder.close()).toEqual([]);
  });
});

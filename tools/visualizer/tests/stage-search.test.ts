import { describe, expect, it } from "vitest";
import { searchStages } from "../src/services/stage-search";
import { stageFor } from "./stage";

const BUILT = stageFor({
  id: "middle-end/0",
  title: "ir-builder",
  text: ["  v1 = Constant [value=7]", "  v2 = CheckBounds v1, v0"].join("\n"),
});

const AFTER_BCE = stageFor({
  id: "middle-end/1",
  title: "bounds-check-elimination",
  text: ["  v1 = Constant [value=7]", "  v3 = LoadElement v0, v1"].join("\n"),
});

describe("searching every stage", () => {
  it("finds nothing for an empty query", () => {
    const report = searchStages([BUILT], "   ", { regex: false });

    expect(report.total).toBe(0);
    expect(report.hits).toEqual([]);
  });

  it("matches a plain substring whatever the case", () => {
    const report = searchStages([BUILT, AFTER_BCE], "checkbounds", { regex: false });

    expect(report.total).toBe(1);
    expect(report.hits[0]!.stageId).toBe("middle-end/0");
    expect(report.hits[0]!.line).toBe(2);
    expect(report.hits[0]!.text).toBe("v2 = CheckBounds v1, v0");
  });

  it("names the first and last stage a line survives in", () => {
    const report = searchStages([BUILT, AFTER_BCE], "Constant", { regex: false });

    expect(report.stages).toBe(2);
    expect(report.first!.title).toBe("ir-builder");
    expect(report.last!.title).toBe("bounds-check-elimination");
  });

  it("reads the query as a regular expression when asked", () => {
    const report = searchStages([BUILT, AFTER_BCE], "v\\d+ = (Load|Check)", { regex: true });

    expect(report.hits.map((hit) => hit.title)).toEqual([
      "ir-builder",
      "bounds-check-elimination",
    ]);
  });

  it("reports a broken regular expression instead of throwing", () => {
    const report = searchStages([BUILT], "v(", { regex: true });

    expect(report.error).not.toBeNull();
    expect(report.hits).toEqual([]);
  });

  it("caps the hits it returns but still counts them all", () => {
    const report = searchStages([BUILT, AFTER_BCE], "v", { regex: false, limit: 1 });

    expect(report.hits).toHaveLength(1);
    expect(report.total).toBe(4);
    expect(report.capped).toBe(true);
  });

  it("answers the same thing when the same stages are searched again", () => {
    const first = searchStages([BUILT, AFTER_BCE], "Constant", { regex: false });
    const second = searchStages([BUILT, AFTER_BCE], "Constant", { regex: false });

    expect(second.total).toBe(first.total);
    expect(second.hits).toEqual(first.hits);
  });

  it("reads a stage's new text rather than the text it cached before", () => {
    const was = stageFor({ id: "s/1", text: "v1 = Int32Add" });
    const now = stageFor({ id: "s/1", text: "v1 = Int32Sub" });

    expect(searchStages([was], "Int32Add", { regex: false }).total).toBe(1);
    expect(searchStages([now], "Int32Add", { regex: false }).total).toBe(0);
    expect(searchStages([now], "Int32Sub", { regex: false }).total).toBe(1);
  });
});

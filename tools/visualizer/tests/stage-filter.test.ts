import { describe, expect, it } from "vitest";
import { notable, notableOnly, quietCount } from "../src/services/stage-filter";
import { NO_REMARKS, type Stage, type StageRemark } from "../src/types/stage";

function stage(id: string, changed: boolean, remarks: readonly StageRemark[] = NO_REMARKS): Stage {
  return {
    id,
    group: "middle-end",
    kind: "ir",
    title: id,
    subtitle: "fn hot",
    owner: "hot",
    ordinal: 0,
    changed,
    failed: false,
    text: "",
    passName: id,
    metrics: null,
    requires: [],
    invalidated: [],
    remarks,
    allocation: null,
    positions: {},
  };
}

const EXPLAINED: readonly StageRemark[] = [
  { kind: "missed", node: "v3", message: "index range unknown" },
];

describe("deciding which stages are worth showing", () => {
  it("keeps a pass that rewrote the graph", () => {
    expect(notable(stage("sccp", true))).toBe(true);
  });

  it("keeps a pass that changed nothing but said why", () => {
    expect(notable(stage("bounds-check-elimination", false, EXPLAINED))).toBe(true);
  });

  it("drops a pass that neither changed anything nor explained itself", () => {
    expect(notable(stage("gvn", false))).toBe(false);
  });

  it("filters a run down to the stages a reader can learn from", () => {
    const stages = [
      stage("sccp", true),
      stage("gvn", false),
      stage("bounds-check-elimination", false, EXPLAINED),
    ];

    expect(notableOnly(stages).map((kept) => kept.id)).toEqual([
      "sccp",
      "bounds-check-elimination",
    ]);
    expect(quietCount(stages)).toBe(1);
  });
});

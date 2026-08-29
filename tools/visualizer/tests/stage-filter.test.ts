import { describe, expect, it } from "vitest";
import { notable, notableOnly, quietCount } from "../src/services/stage-filter";
import { NO_REMARKS, type Stage, type StageRemark } from "../src/types/stage";
import { stageFor } from "./stage";

function stage(id: string, changed: boolean, remarks: readonly StageRemark[] = NO_REMARKS): Stage {
  return stageFor({ id, changed, remarks });
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

  it("keeps a pass that broke an invariant even though it changed nothing", () => {
    const broke = stageFor({
      id: "gvn",
      changed: false,
      failed: true,
      verification: ["v3 is used before it is defined"],
    });

    expect(notable(broke)).toBe(true);
    expect(notableOnly([broke])).toEqual([broke]);
    expect(quietCount([broke])).toBe(0);
  });
});

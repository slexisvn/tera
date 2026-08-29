import { describe, expect, it } from "vitest";
import { analysisHistory } from "../src/services/analysis-history";
import type { Stage } from "../src/types/stage";
import { stageFor } from "./stage";

function pass(
  title: string,
  ordinal: number,
  requires: readonly string[],
  invalidated: readonly string[],
  owner = "hot",
): Stage {
  return stageFor({
    id: `${owner}/${ordinal}`,
    title,
    subtitle: owner,
    owner,
    ordinal,
    passName: title,
    requires,
    invalidated,
  });
}

describe("tracing where a pass's analyses came from", () => {
  it("says an analysis was recomputed when an earlier pass threw it away", () => {
    const licm = pass("licm", 3, ["loops"], []);
    const stages = [
      pass("ir-builder", 0, [], []),
      pass("sccp", 1, [], ["loops", "points-to"]),
      pass("dce", 2, [], []),
      licm,
    ];

    expect(analysisHistory(stages, licm)).toEqual([
      { name: "loops", invalidatedBy: "sccp", passesAgo: 2, recomputed: true },
    ]);
  });

  it("names the most recent pass to invalidate it, not the first", () => {
    const licm = pass("licm", 3, ["loops"], []);
    const stages = [
      pass("sccp", 0, [], ["loops"]),
      pass("unswitching", 1, [], ["loops"]),
      pass("dce", 2, [], []),
      licm,
    ];

    expect(analysisHistory(stages, licm)[0]).toMatchObject({
      invalidatedBy: "unswitching",
      passesAgo: 2,
    });
  });

  it("reports an analysis nobody invalidated as reused, not recomputed", () => {
    const licm = pass("licm", 2, ["dominance"], []);
    const stages = [pass("ir-builder", 0, [], []), pass("dce", 1, [], ["points-to"]), licm];

    expect(analysisHistory(stages, licm)).toEqual([
      { name: "dominance", invalidatedBy: null, passesAgo: 2, recomputed: false },
    ]);
  });

  it("counts the very first pass as having to compute what it asks for", () => {
    const first = pass("parameter-type-guards", 0, ["dominance"], []);

    expect(analysisHistory([first], first)[0]).toMatchObject({
      recomputed: true,
      invalidatedBy: null,
    });
  });

  it("ignores what happened to another function's analyses", () => {
    const licm = pass("licm", 3, ["loops"], []);
    const stages = [pass("sccp", 1, [], ["loops"], "cold"), licm];

    expect(analysisHistory(stages, licm)[0]).toMatchObject({ invalidatedBy: null });
  });

  it("has nothing to say about a pass that reads no analysis", () => {
    const sccp = pass("sccp", 1, [], ["loops"]);

    expect(analysisHistory([sccp], sccp)).toEqual([]);
  });
});

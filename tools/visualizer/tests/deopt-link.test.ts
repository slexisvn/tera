import { describe, expect, it } from "vitest";
import { guardOf, opcodesOf, targetForDeopt } from "../src/services/deopt-link";
import { NO_REMARKS, type DeoptOrigin, type Stage } from "../src/types/stage";

function graphStage(
  id: string,
  owner: string,
  text: string,
  positions: Record<string, number> = {},
): Stage {
  return {
    id,
    group: "middle-end",
    kind: "ir",
    title: id,
    subtitle: owner,
    owner,
    ordinal: 0,
    changed: true,
    failed: false,
    text,
    passName: id,
    metrics: null,
    requires: [],
    invalidated: [],
    remarks: NO_REMARKS,
    allocation: null,
    positions,
  };
}

function origin(over: Partial<DeoptOrigin> = {}): DeoptOrigin {
  return {
    owner: "hot",
    reason: "map-check-failed",
    node: "v3",
    opcode: "CheckMap",
    line: 4,
    candidates: ["v3"],
    ...over,
  };
}

const GUARDED = `fn hot params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v3 = CheckMap v0 [map=7]
    v5 = LoadField v3 [offset=0]
}
`;

const LOWERED = `fn hot params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v3 = PolymorphicLoad v0 [maps=[7, 8]]
}
`;

const LOWERED_ELSEWHERE = `fn hot params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v9 = CheckMap v0 [map=7]
    v11 = LoadField v9 [offset=0]
}
`;

const TWICE = `fn hot params=1 {
  B0 succs= preds=:
    v9 = CheckMap v0 [map=7]
    v10 = CheckMap v1 [map=8]
}
`;

describe("opcodesOf", () => {
  it("reads the opcode each value is defined by, ignoring uses", () => {
    expect([...opcodesOf(GUARDED)]).toEqual([
      ["v0", "Parameter"],
      ["v3", "CheckMap"],
      ["v5", "LoadField"],
    ]);
  });
});

describe("guardOf", () => {
  it("takes the resolved node when the runtime named one", () => {
    expect(guardOf(origin({ node: "v3", candidates: ["v3", "v9"] }))).toBe("v3");
  });

  it("takes the only candidate when the runtime named none", () => {
    expect(guardOf(origin({ node: null, candidates: ["v9"] }))).toBe("v9");
  });

  it("refuses to guess between several candidates", () => {
    expect(guardOf(origin({ node: null, candidates: ["v3", "v9"] }))).toBeNull();
  });
});

describe("targetForDeopt", () => {
  it("selects the node when a stage agrees on both its id and its opcode", () => {
    const stages = [graphStage("early", "hot", GUARDED, { v3: 4 })];

    expect(targetForDeopt(stages, origin())).toEqual({
      stageId: "early",
      node: "v3",
      line: 4,
      match: "node",
    });
  });

  it("reports the guard as retired when the graph no longer contains that operation at all", () => {
    const stages = [graphStage("lowered", "hot", LOWERED, { v3: 4 })];

    expect(targetForDeopt(stages, origin())).toEqual({
      stageId: "lowered",
      node: null,
      line: 4,
      match: "retired",
    });
  });

  it("falls back to the one guard on the reported source line after a renumbering", () => {
    const stages = [graphStage("renumbered", "hot", LOWERED_ELSEWHERE, { v9: 4, v11: 4 })];

    expect(targetForDeopt(stages, origin())).toEqual({
      stageId: "renumbered",
      node: "v9",
      line: 4,
      match: "line",
    });
  });

  it("picks no node, but does not call the guard retired, when the line holds several of that operation", () => {
    const stages = [graphStage("ambiguous", "hot", TWICE, { v9: 4, v10: 4 })];

    expect(targetForDeopt(stages, origin())).toEqual({
      stageId: "ambiguous",
      node: null,
      line: 4,
      match: "graph",
    });
  });

  it("prefers the latest stage that still holds the guard", () => {
    const stages = [
      graphStage("early", "hot", GUARDED, { v3: 4 }),
      graphStage("late", "hot", GUARDED, { v3: 9 }),
    ];

    expect(targetForDeopt(stages, origin())).toMatchObject({ stageId: "late", line: 9 });
  });

  it("still reaches a node by source line when the frame state named several guards", () => {
    const stages = [graphStage("late", "hot", GUARDED, { v3: 4 })];

    expect(targetForDeopt(stages, origin({ node: null, candidates: ["v3", "v9"] }))).toEqual({
      stageId: "late",
      node: "v3",
      line: 4,
      match: "line",
    });
  });

  it("opens the last graph with no node when neither the id nor the line resolves one", () => {
    const stages = [graphStage("late", "hot", LOWERED, { v3: 4 })];

    expect(targetForDeopt(stages, origin({ node: null, candidates: ["v3", "v9"] }))).toMatchObject({
      stageId: "late",
      node: null,
      line: 4,
    });
  });

  it("ignores graphs belonging to a different function", () => {
    expect(targetForDeopt([graphStage("other", "cold", GUARDED)], origin())).toBeNull();
  });

  it("answers nothing when the compile produced no graph at all", () => {
    expect(targetForDeopt([], origin())).toBeNull();
  });
});

import { NO_REMARKS, NOTHING_BROKEN, type Stage } from "../src/types/stage";

export function stageFor(over: Partial<Stage> & Pick<Stage, "id">): Stage {
  return {
    group: "middle-end",
    kind: "ir",
    title: over.id,
    subtitle: "fn hot",
    owner: "hot",
    ordinal: 0,
    changed: true,
    failed: false,
    skipped: false,
    elapsedMs: 0,
    verification: NOTHING_BROKEN,
    text: "",
    passName: over.id,
    metrics: null,
    requires: [],
    invalidated: [],
    remarks: NO_REMARKS,
    allocation: null,
    positions: {},
    ...over,
  };
}

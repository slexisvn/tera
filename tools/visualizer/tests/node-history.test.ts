import { describe, expect, it } from "vitest";
import { historyOf } from "../src/services/node-history";
import { stageFor } from "./stage";

function graph(blocks: readonly string[]): string {
  return ["fn hot params=1 {", "  v0 = Parameter [index=0]", ...blocks, "}"].join("\n");
}

const BEFORE = graph([
  "  B0 succs=B1 preds=:",
  "    v1 = Constant [value=7]",
  "  B1 succs= preds=B0:",
  "    v2 = Int32Add v0, v1",
  "    v3 = Return v2",
]);

const HOISTED = graph([
  "  B0 succs=B1 preds=:",
  "    v1 = Constant [value=7]",
  "    v2 = Int32Add v0, v1",
  "  B1 succs= preds=B0:",
  "    v3 = Return v2",
]);

const REWRITTEN = graph([
  "  B0 succs=B1 preds=:",
  "    v1 = Constant [value=7]",
  "    v2 = Int32Sub v0, v1",
  "  B1 succs= preds=B0:",
  "    v3 = Return v2",
]);

const GONE = graph([
  "  B0 succs=B1 preds=:",
  "    v1 = Constant [value=7]",
  "  B1 succs= preds=B0:",
  "    v3 = Return v1",
]);

const TRACE = [
  stageFor({ id: "s0", title: "ir-builder", text: BEFORE }),
  stageFor({ id: "s1", title: "sccp", text: BEFORE }),
  stageFor({ id: "s2", title: "licm", text: HOISTED }),
  stageFor({ id: "s3", title: "strength-reduction", text: REWRITTEN }),
  stageFor({ id: "s4", title: "dead-code-elimination", text: GONE }),
];

describe("following one value through the pipeline", () => {
  it("tells born, untouched, moved, rewritten and deleted apart", () => {
    const history = historyOf(TRACE, "hot", "v2");

    expect(history.moments.map((moment) => [moment.title, moment.kind])).toEqual([
      ["ir-builder", "born"],
      ["sccp", "held"],
      ["licm", "moved"],
      ["strength-reduction", "rewritten"],
      ["dead-code-elimination", "gone"],
    ]);
  });

  it("names the pass that created it and the pass that deleted it", () => {
    const history = historyOf(TRACE, "hot", "v2");

    expect(history.bornIn!.title).toBe("ir-builder");
    expect(history.goneIn!.title).toBe("dead-code-elimination");
  });

  it("carries the block a value sits in, so a move is visible", () => {
    const moved = historyOf(TRACE, "hot", "v2").moments.find(
      (moment) => moment.kind === "moved",
    );

    expect(moved!.block).toBe("B0");
  });

  it("reads the value's own line at every step", () => {
    const rewritten = historyOf(TRACE, "hot", "v2").moments.find(
      (moment) => moment.kind === "rewritten",
    );

    expect(rewritten!.text).toBe("v2 = Int32Sub v0, v1");
  });

  it("says nothing about a value that belongs to another function", () => {
    const history = historyOf(TRACE, "cold", "v2");

    expect(history.moments).toEqual([]);
    expect(history.bornIn).toBeNull();
  });

  it("leaves the executed-graph copy out, since it is not a step in the pipeline", () => {
    const withExecuted = [
      ...TRACE,
      stageFor({ id: "executed/hot", group: "executed", title: "hot", text: BEFORE }),
    ];

    expect(historyOf(withExecuted, "hot", "v2").moments).toHaveLength(TRACE.length);
  });
});

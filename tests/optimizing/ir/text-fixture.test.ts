import { beforeEach, describe, expect, it } from "vitest";
import { resetIRNodeIds } from "../../../src/optimizing/ir/index.js";
import { deadCodeElimination } from "../../../src/optimizing/passes/dce.js";
import { sparseConditionalConstantPropagation } from "../../../src/optimizing/passes/sccp.js";
import { eliminateRedundantChecks } from "../../../src/optimizing/passes/checks.js";
import { dominanceAnalysisId } from "../../../src/optimizing/analyses/dominance.js";
import { afterPass, valuesIn } from "../../helpers/ir-text.js";

beforeEach(() => resetIRNodeIds());

describe("driving dead code elimination from text", () => {
  const WITH_DEAD_VALUE = `fn dead params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Constant [value=7]
    v2 = Int32Add v0, v1
    v3 = Int32Mul v0, v0
    v4 = Return v2
}
`;

  it("drops the value nothing consumes and keeps the rest", () => {
    const after = afterPass(WITH_DEAD_VALUE, (graph) => deadCodeElimination(graph));
    expect(valuesIn(after)).toEqual(["v0", "v1", "v2", "v4"]);
  });

  it("keeps a value once a return starts consuming it", () => {
    const consumed = WITH_DEAD_VALUE.replace("v4 = Return v2", "v4 = Return v3");
    const after = afterPass(consumed, (graph) => deadCodeElimination(graph));
    expect(valuesIn(after)).toContain("v3");
  });
});

describe("driving constant propagation from text", () => {
  const FOLDABLE = `fn folds params=0 {
  B0 succs= preds=:
    v0 = Constant [value=20]
    v1 = Constant [value=22]
    v2 = Int32Add v0, v1
    v3 = Return v2
}
`;

  it("replaces the sum with the constant it always produces", () => {
    const after = afterPass(FOLDABLE, (graph) =>
      sparseConditionalConstantPropagation(graph),
    );
    expect(after).toContain("Constant [value=42]");
    expect(after).not.toContain("Int32Add");
  });

  it("leaves the sum alone when an operand is not a constant", () => {
    const open = `fn open params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Constant [value=22]
    v2 = Int32Add v0, v1
    v3 = Return v2
}
`;
    expect(afterPass(open, (graph) => sparseConditionalConstantPropagation(graph))).toContain(
      "Int32Add",
    );
  });
});

describe("driving redundant check elimination from text", () => {
  const DOMINATED_CHECK = `fn checks params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1 preds=:
    v1 = CheckSmi v0 !fs
    v2 = Jump [targetBlock=1]
  B1 succs= preds=B0:
    v3 = CheckSmi v0 !fs
    v4 = Return v3
}
`;

  it("removes the check a dominating one already made", () => {
    const after = afterPass(DOMINATED_CHECK, (graph, analyses) =>
      eliminateRedundantChecks(graph, analyses.get(dominanceAnalysisId)),
    );
    expect(after).toContain("v1 = CheckSmi v0");
    expect(after).not.toContain("v3 = CheckSmi");
    expect(after).toContain("Return v1");
  });

  it("keeps a check on a different value", () => {
    const other = DOMINATED_CHECK.replace("v3 = CheckSmi v0", "v3 = CheckSmi v1");
    const after = afterPass(other, (graph, analyses) =>
      eliminateRedundantChecks(graph, analyses.get(dominanceAnalysisId)),
    );
    expect(after).toContain("v3 = CheckSmi v1");
  });
});

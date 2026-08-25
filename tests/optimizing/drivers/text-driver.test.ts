import { beforeEach, describe, expect, it } from "vitest";
import { resetIRNodeIds } from "../../../src/optimizing/ir/index.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import { middleEndPipeline } from "../../../src/optimizing/pipeline.js";
import {
  afterNamedPass,
  middleEndPassNames,
  passByName,
  UnknownPassError,
} from "../../../src/optimizing/drivers/text-driver.js";
import { valuesIn } from "../../helpers/ir-text.js";

beforeEach(() => resetIRNodeIds());

const FOLDABLE = `fn folds params=0 {
  B0 succs= preds=:
    v0 = Constant [value=20]
    v1 = Constant [value=22]
    v2 = Int32Add v0, v1
    v3 = Return v2
}
`;

const WITH_DEAD_VALUE = `fn dead params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Constant [value=7]
    v2 = Int32Add v0, v1
    v3 = Int32Mul v0, v0
    v4 = Return v2
}
`;

describe("naming the middle-end passes", () => {
  it("lists exactly the passes the pipeline will run", () => {
    const options = compilerOptions("speed");

    expect(middleEndPassNames(options)).toEqual(
      middleEndPipeline(options).map((pass) => pass.name),
    );
  });

  it("resolves a pass the pipeline contains", () => {
    expect(passByName("sccp")?.name).toBe("sccp");
  });

  it("answers null for a name no pass carries", () => {
    expect(passByName("no-such-pass")).toBeNull();
  });

  it("lists fewer passes at an optimization level that disables some", () => {
    const off = compilerOptions("speed", { scalarReplaceAggregates: false });

    expect(middleEndPassNames(off)).not.toContain("escape-analysis");
    expect(middleEndPassNames(compilerOptions("speed"))).toContain("escape-analysis");
  });
});

describe("running one named pass over textual IR", () => {
  it("folds the sum the way the pipeline's own sccp does", () => {
    const after = afterNamedPass(FOLDABLE, "sccp");

    expect(after).toContain("Constant [value=42]");
    expect(after).not.toContain("Int32Add");
  });

  it("drops the value nothing consumes", () => {
    const after = afterNamedPass(WITH_DEAD_VALUE, "dead-code-elimination");

    expect(valuesIn(after)).toEqual(["v0", "v1", "v2", "v4"]);
  });

  it("leaves the graph alone when the pass has nothing to do", () => {
    expect(afterNamedPass(WITH_DEAD_VALUE, "gvn")).toBe(WITH_DEAD_VALUE);
  });

  it("names the pass it could not find", () => {
    expect(() => afterNamedPass(FOLDABLE, "no-such-pass")).toThrow(UnknownPassError);
    expect(() => afterNamedPass(FOLDABLE, "no-such-pass")).toThrow('"no-such-pass"');
  });

  it("returns text that parses back into the same graph", () => {
    const after = afterNamedPass(FOLDABLE, "sccp");

    expect(afterNamedPass(after, "gvn")).toBe(after);
  });
});

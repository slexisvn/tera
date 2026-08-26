import { beforeEach, describe, expect, it } from "vitest";
import { resetIRNodeIds } from "../../../src/optimizing/ir/index.js";
import { runNamedPass } from "../../../src/optimizing/drivers/text-driver.js";
import type { Remark } from "../../../src/optimizing/infra/pass-remarks.js";

beforeEach(() => resetIRNodeIds());

const ESCAPING_OBJECT = `fn escapes params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = NewObject
    v2 = GenericSetProp v1, v0 [propName="x"]
    v3 = Return v1
}
`;

const CONTAINED_OBJECT = `fn contained params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = NewObject
    v2 = GenericSetProp v1, v0 [propName="x"]
    v3 = GenericGetProp v1 [propName="x"]
    v4 = Return v3
}
`;

const OPAQUE_INDEX = `fn indexes params=2 {
  v0 = Parameter [index=0]
  v1 = Parameter [index=1]
  B0 succs= preds=:
    v2 = CheckBounds v0, v1
    v3 = Return v2
}
`;

const CONSTANT_INDEX = `fn indexes params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Constant [value=3]
    v2 = CheckBounds v1, v0
    v3 = Return v2
}
`;

function about(remarks: readonly Remark[], node: number): readonly Remark[] {
  return remarks.filter((remark) => remark.node === node);
}

describe("escape analysis explains itself", () => {
  it("names the allocation it refused to scalar replace and why it escapes", () => {
    const outcome = runNamedPass(ESCAPING_OBJECT, "escape-analysis");

    const [missed] = about(outcome.remarks, 1);
    expect(outcome.changed).toBe(false);
    expect(missed?.kind).toBe("missed");
    expect(missed?.pass).toBe("escape-analysis");
    expect(missed?.message).toContain("escapes");
  });

  it("reports a success rather than an escape when the object stays put", () => {
    const outcome = runNamedPass(CONTAINED_OBJECT, "escape-analysis");

    const [applied] = about(outcome.remarks, 1);
    expect(applied?.kind).toBe("applied");
    expect(applied?.message).toContain("never escapes");
  });
});

describe("bounds check elimination explains itself", () => {
  it("says the index range is unknown when the index is an opaque parameter", () => {
    const outcome = runNamedPass(OPAQUE_INDEX, "bounds-check-elimination");

    const [missed] = about(outcome.remarks, 2);
    expect(missed?.kind).toBe("missed");
    expect(missed?.message).toContain("range");
    expect(missed?.message).toContain("upper bound");
  });

  it("gives a different reason once the index has a known range but no known length", () => {
    const outcome = runNamedPass(CONSTANT_INDEX, "bounds-check-elimination");

    const [missed] = about(outcome.remarks, 2);
    expect(missed?.kind).toBe("missed");
    expect(missed?.message).toContain("[3,3]");
    expect(missed?.message).not.toContain("upper bound");
  });
});

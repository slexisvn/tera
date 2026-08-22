import { describe, expect, it } from "vitest";
import {
  defaultDelivery,
  missingEntryReason,
  programEntryShape,
  type EntryDelivery,
} from "../../../src/optimizing/target/entry.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_POINTER,
  SCALAR_STRING,
  SCALAR_TEXT,
  SCALAR_VOID,
  type AotScalar,
} from "../../../src/optimizing/types/scalar.js";
import type { AotSkippedFunction } from "../../../src/optimizing/target/artifact.js";

const SCALARS: readonly AotScalar[] = [
  SCALAR_INT32,
  SCALAR_FLOAT64,
  SCALAR_STRING,
  SCALAR_TEXT,
  SCALAR_POINTER,
  SCALAR_VOID,
];

const ENTRY_RESULTS: readonly AotScalar[] = [SCALAR_INT32, SCALAR_FLOAT64, SCALAR_STRING];

function shape(returns: AotScalar, delivery: EntryDelivery, ...parameters: readonly AotScalar[]) {
  return programEntryShape(parameters, returns, delivery);
}

function skipped(name: string, reason: string, missing?: string): AotSkippedFunction {
  return missing === undefined ? { name, reason } : { name, reason, missing };
}

describe("how a program entry delivers its result by default", () => {
  it("hands an int back as the exit status", () => {
    expect(defaultDelivery(SCALAR_INT32)).toBe("exit");
  });

  it("prints every result an exit status cannot carry", () => {
    for (const scalar of SCALARS.filter((candidate) => candidate !== SCALAR_INT32)) {
      expect(defaultDelivery(scalar)).toBe("print");
    }
  });

  it("chooses a delivery the shape then accepts, for every result an entry may return", () => {
    for (const scalar of ENTRY_RESULTS) {
      expect(shape(scalar, defaultDelivery(scalar)).ok).toBe(true);
    }
  });
});

describe("the shape a program entry must have", () => {
  it("accepts an int entry that leaves through the exit status", () => {
    expect(shape(SCALAR_INT32, "exit")).toEqual({
      ok: true,
      shape: { result: "int", delivery: "exit" },
    });
  });

  it("accepts an int entry that prints instead", () => {
    expect(shape(SCALAR_INT32, "print")).toEqual({
      ok: true,
      shape: { result: "int", delivery: "print" },
    });
  });

  it("accepts a float entry that prints", () => {
    expect(shape(SCALAR_FLOAT64, "print")).toEqual({
      ok: true,
      shape: { result: "float", delivery: "print" },
    });
  });

  it("accepts a string entry that prints", () => {
    expect(shape(SCALAR_STRING, "print")).toEqual({
      ok: true,
      shape: { result: "string", delivery: "print" },
    });
  });

  it("refuses an entry that declares parameters, naming the ones it found", () => {
    const refused = shape(SCALAR_INT32, "exit", SCALAR_INT32, SCALAR_STRING);

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain(`(${SCALAR_INT32}, ${SCALAR_STRING})`);
    expect(refused.ok === false && refused.reason).toContain("input()");
  });

  it("refuses parameters before it looks at the result", () => {
    const refused = shape(SCALAR_VOID, "exit", SCALAR_INT32);

    expect(refused.ok === false && refused.reason).toContain(`(${SCALAR_INT32})`);
  });

  it("refuses a result no entry can carry, listing the ones it can", () => {
    for (const scalar of SCALARS.filter((candidate) => !ENTRY_RESULTS.includes(candidate))) {
      const refused = shape(scalar, "print");

      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.reason).toContain(`returns ${scalar}`);
      expect(refused.ok === false && refused.reason).toContain("int, float, string");
    }
  });

  it("refuses an exit status the result cannot fit in", () => {
    for (const scalar of ENTRY_RESULTS.filter((candidate) => candidate !== SCALAR_INT32)) {
      const refused = shape(scalar, "exit");

      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.reason).toContain("exit status");
    }
  });
});

describe("why an entry function is missing", () => {
  it("names the functions that were compiled when the entry was not one of them", () => {
    const reason = missingEntryReason("main", ["helper", "total"], []);

    expect(reason).toContain("no compiled function is named main");
    expect(reason).toContain("available: helper, total");
  });

  it("leaves the hint out when nothing was compiled", () => {
    const reason = missingEntryReason("main", [], []);

    expect(reason).toBe("no compiled function is named main");
  });

  it("reports the entry's own reason when the entry itself was skipped", () => {
    const reason = missingEntryReason("main", [], [skipped("main", "it allocates a closure")]);

    expect(reason).toContain("entry function main could not be lowered");
    expect(reason).toContain("it allocates a closure");
    expect(reason).not.toContain("it calls");
  });

  it("follows the callee chain to the function that actually could not be lowered", () => {
    const reason = missingEntryReason(
      "main",
      [],
      [
        skipped("main", "it calls a function that was skipped", "middle"),
        skipped("middle", "it calls a function that was skipped", "leaf"),
        skipped("leaf", "it allocates a closure"),
      ],
    );

    expect(reason).toContain("it calls middle -> leaf");
    expect(reason).toContain("skipped because it allocates a closure");
  });

  it("stops at the last skipped function when the chain names one that was not skipped", () => {
    const reason = missingEntryReason(
      "main",
      [],
      [skipped("main", "it calls a function that was skipped", "absent")],
    );

    expect(reason).toContain("it calls a function that was skipped");
    expect(reason).not.toContain("->");
  });

  it("stops instead of looping when the chain points back at a function it already followed", () => {
    const reason = missingEntryReason(
      "main",
      [],
      [
        skipped("main", "main waits on other", "other"),
        skipped("other", "other waits on main", "main"),
      ],
    );

    expect(reason).toContain("it calls other");
    expect(reason).toContain("other waits on main");
  });

  it("stops instead of looping when a skipped function names itself", () => {
    const reason = missingEntryReason("main", [], [skipped("main", "main waits on main", "main")]);

    expect(reason).toContain("main waits on main");
    expect(reason).not.toContain("it calls");
  });
});

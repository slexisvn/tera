import { describe, expect, it } from "vitest";
import { summarizeDeopts } from "../src/services/deopt-summary";
import type { DeoptOrigin, RuntimeEvent } from "../src/types/stage";

function deopt(owner: string, reason: string, node: string | null, at: number): RuntimeEvent {
  const origin: DeoptOrigin = {
    owner,
    reason,
    node,
    opcode: "CheckMap",
    line: 3,
    candidates: [],
  };
  return { category: "deopt", message: `${owner}: ${reason}`, at, origin };
}

const OTHER: RuntimeEvent = { category: "jit", message: "compiled", at: 0, origin: null };

describe("summarizing deopts", () => {
  it("reports nothing when the run never deoptimized", () => {
    const summary = summarizeDeopts([OTHER]);

    expect(summary).toEqual({ groups: [], total: 0, looping: 0 });
  });

  it("counts the same guard failing again as one place", () => {
    const summary = summarizeDeopts([
      deopt("drive", "wrong-map", "v12", 1),
      deopt("drive", "wrong-map", "v12", 2),
    ]);

    expect(summary.total).toBe(2);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]!.count).toBe(2);
  });

  it("keeps two different reasons in the same function apart", () => {
    const summary = summarizeDeopts([
      deopt("drive", "wrong-map", "v12", 1),
      deopt("drive", "not-a-smi", "v30", 2),
    ]);

    expect(summary.groups).toHaveLength(2);
  });

  it("flags a guard that failed as often as the engine tolerates", () => {
    const summary = summarizeDeopts([
      deopt("drive", "wrong-map", "v12", 1),
      deopt("drive", "wrong-map", "v12", 2),
      deopt("drive", "wrong-map", "v12", 3),
    ]);

    expect(summary.groups[0]!.looping).toBe(true);
    expect(summary.looping).toBe(1);
  });

  it("puts the busiest place first", () => {
    const summary = summarizeDeopts([
      deopt("quiet", "not-a-smi", "v1", 1),
      deopt("busy", "wrong-map", "v2", 2),
      deopt("busy", "wrong-map", "v2", 3),
    ]);

    expect(summary.groups.map((group) => group.owner)).toEqual(["busy", "quiet"]);
  });
});

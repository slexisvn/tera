import { describe, expect, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const CAPTURED_LOOP_LOCAL = src(
  "fn run(n):",
  "  total = 0",
  "  i = 0",
  "  while i < n:",
  "    x = i * 2",
  "    get = () => x",
  "    x = x + 1",
  "    total = total + get()",
  "    i = i + 1",
  "  return total",
  "out = 0",
  "j = 0",
  "while j < 40:",
  "  out = out + run(20)",
  "  j = j + 1",
  "out",
);

const PRUNED_TEMPORARY_THEN_DEOPT = src(
  "fn run(n, flip):",
  "  total = 0",
  "  i = 0",
  "  while i < n:",
  "    a = i + 1",
  "    b = a * 2",
  "    a = b - i",
  "    if i == flip:",
  "      a = a + 0.5",
  "    total = total + a + b",
  "    i = i + 1",
  "  return total",
  "run(300, 200)",
);

const CARRIED_ACROSS_THE_BACKEDGE = src(
  "fn run(n, flip):",
  "  total = 0",
  "  step = 3",
  "  i = 0",
  "  while i < n:",
  "    total = total + step",
  "    if i == flip:",
  "      total = total + 0.5",
  "    i = i + 1",
  "  return total",
  "run(300, 200)",
);

const REASSIGNED_PARAMETER = src(
  "fn run(a, b, n):",
  "  i = 0",
  "  while i < n:",
  "    a = a + b",
  "    b = a - b",
  "    i = i + 1",
  "  return a + b",
  "run(1, 2, 300)",
);

describe("a deopt frame that only carries the registers the resume point reads", () => {
  it("still reads a loop local that a closure captured", () => {
    expect(differential(CAPTURED_LOOP_LOCAL)).toEqual(16000);
  });

  it("still deoptimizes correctly after the loop temporaries were pruned", () => {
    expect(differential(PRUNED_TEMPORARY_THEN_DEOPT)).toEqual(135750.5);
  });

  it("still reads a local only the next iteration goes back for", () => {
    expect(differential(CARRIED_ACROSS_THE_BACKEDGE)).toEqual(900.5);
  });

  it("still resumes with the current value of a reassigned parameter", () => {
    differential(REASSIGNED_PARAMETER);
  });
});

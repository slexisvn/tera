import { describe, expect, it } from "vitest";
import { Worklist } from "../../../src/optimizing/infra/worklist.js";

describe("Worklist", () => {
  it("starts empty", () => {
    const worklist = new Worklist<number>();
    expect(worklist.isEmpty).toBe(true);
    expect(worklist.size).toBe(0);
    expect(worklist.take()).toBeUndefined();
  });

  it("ignores an item that is already queued", () => {
    const worklist = new Worklist<number>([1, 1, 2, 1]);
    expect(worklist.size).toBe(2);
  });

  it("drains in first-in-first-out order", () => {
    const worklist = new Worklist<string>(["a", "b", "c"]);
    expect([worklist.take(), worklist.take(), worklist.take()]).toEqual(["a", "b", "c"]);
    expect(worklist.isEmpty).toBe(true);
  });

  it("reports size as the number of not-yet-taken items", () => {
    const worklist = new Worklist<number>([1, 2, 3]);
    worklist.take();
    expect(worklist.size).toBe(2);
  });

  it("allows re-adding an item after it has been taken", () => {
    const worklist = new Worklist<number>([7]);
    expect(worklist.take()).toBe(7);
    worklist.add(7);
    expect(worklist.size).toBe(1);
    expect(worklist.take()).toBe(7);
  });

  it("preserves every distinct item across backing-buffer compaction", () => {
    const worklist = new Worklist<number>();
    const drained: number[] = [];
    for (let i = 0; i < 500; i++) worklist.add(i);
    for (let i = 0; i < 300; i++) drained.push(worklist.take()!);
    for (let i = 500; i < 800; i++) worklist.add(i);
    while (!worklist.isEmpty) drained.push(worklist.take()!);
    expect(drained).toHaveLength(800);
    expect(new Set(drained).size).toBe(800);
  });
});

import { describe, expect, it } from "vitest";
import { PriorityQueue } from "../../../src/optimizing/infra/priority-queue.js";

const ascending = (left: number, right: number) => left - right;

function drain<T>(queue: PriorityQueue<T>): T[] {
  const taken: T[] = [];
  for (;;) {
    const item = queue.take();
    if (item === undefined) return taken;
    taken.push(item);
  }
}

describe("PriorityQueue", () => {
  it("hands back an unordered seed in order", () => {
    const queue = new PriorityQueue(ascending, [5, 1, 4, 1, 3, 2]);
    expect(drain(queue)).toEqual([1, 1, 2, 3, 4, 5]);
  });

  it("orders items pushed after draining has already started", () => {
    const queue = new PriorityQueue(ascending, [10, 20]);
    expect(queue.take()).toBe(10);
    queue.push(15);
    queue.push(5);
    expect(drain(queue)).toEqual([5, 15, 20]);
  });

  it("reports emptiness and size as it drains", () => {
    const queue = new PriorityQueue(ascending, [2, 1]);
    expect([queue.size, queue.isEmpty]).toEqual([2, false]);
    queue.take();
    queue.take();
    expect([queue.size, queue.isEmpty, queue.take()]).toEqual([0, true, undefined]);
  });

  it("peeks the smallest item without removing it", () => {
    const queue = new PriorityQueue(ascending, [7, 3]);
    expect(queue.peek()).toBe(3);
    expect(queue.size).toBe(2);
  });

  it("follows the ordering it was given rather than natural order", () => {
    const queue = new PriorityQueue<number>((left, right) => right - left, [1, 9, 5]);
    expect(drain(queue)).toEqual([9, 5, 1]);
  });
});

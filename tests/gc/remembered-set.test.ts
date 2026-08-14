import { describe, it, expect } from "vitest";
import { RememberedSet } from "../../src/gc/remembered-set.js";

describe("RememberedSet", () => {
  it("record/has/remove lifecycle", () => {
    const rs = new RememberedSet();
    const obj = { id: 1 };
    expect(rs.has(obj)).toBe(false);
    rs.record(obj);
    expect(rs.has(obj)).toBe(true);
    expect(rs.size).toBe(1);
    rs.remove(obj);
    expect(rs.has(obj)).toBe(false);
    expect(rs.size).toBe(0);
  });

  it("record is idempotent", () => {
    const rs = new RememberedSet();
    const obj = { id: 1 };
    rs.record(obj);
    rs.record(obj);
    expect(rs.size).toBe(1);
  });

  it("clear removes all entries", () => {
    const rs = new RememberedSet();
    rs.record({ id: 1 });
    rs.record({ id: 2 });
    rs.record({ id: 3 });
    rs.clear();
    expect(rs.size).toBe(0);
  });

  it("iterateHolders visits all recorded holders", () => {
    const rs = new RememberedSet();
    const a = { id: "a" };
    const b = { id: "b" };
    rs.record(a);
    rs.record(b);
    const visited = [];
    rs.iterateHolders((h) => visited.push(h.id));
    expect(visited.sort()).toEqual(["a", "b"]);
  });

  it("filterDead removes holders that fail predicate", () => {
    const rs = new RememberedSet();
    const live = { id: "live", alive: true };
    const dead = { id: "dead", alive: false };
    rs.record(live);
    rs.record(dead);
    rs.filterDead((h) => h.alive);
    expect(rs.has(live)).toBe(true);
    expect(rs.has(dead)).toBe(false);
    expect(rs.size).toBe(1);
  });
});

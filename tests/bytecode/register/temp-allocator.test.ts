import { describe, it, expect } from "vitest";
import { TempAllocator } from "../../../src/bytecode/register/compiler/temp-allocator.js";

describe("TempAllocator", () => {
  function makeMockFunc(startRegCount = 0) {
    return { registerCount: startRegCount, allocTemp() { return this.registerCount++; } };
  }

  it("alloc returns fresh registers from the function when pool is empty", () => {
    const func = makeMockFunc(3);
    const temps = new TempAllocator(func);
    expect(temps.alloc()).toBe(3);
    expect(temps.alloc()).toBe(4);
    expect(func.registerCount).toBe(5);
  });

  it("free returns register to pool, alloc reuses it (LIFO)", () => {
    const func = makeMockFunc(0);
    const temps = new TempAllocator(func);
    const r0 = temps.alloc();
    const r1 = temps.alloc();
    temps.free(r0);
    temps.free(r1);
    expect(temps.alloc()).toBe(r1);
    expect(temps.alloc()).toBe(r0);
  });

  it("mixed alloc/free pattern avoids growing registerCount when possible", () => {
    const func = makeMockFunc(0);
    const temps = new TempAllocator(func);
    const r0 = temps.alloc();
    temps.free(r0);
    const r0Again = temps.alloc();
    expect(r0Again).toBe(r0);
    expect(func.registerCount).toBe(1);
  });
});

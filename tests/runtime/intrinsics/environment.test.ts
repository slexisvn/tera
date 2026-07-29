import { describe, it, expect } from "vitest";
import {
  UpvalueCell,
  Environment,
} from "../../../src/runtime/intrinsics/environment.js";

describe("UpvalueCell", () => {
  it("reads from frame locals when open", () => {
    const frame = { locals: [10, 20, 30] };
    const cell = new UpvalueCell(frame, 1);
    expect(cell.get()).toBe(20);
  });

  it("writes to frame locals when open", () => {
    const frame = { locals: [10, 20, 30] };
    const cell = new UpvalueCell(frame, 1);
    cell.set(99);
    expect(frame.locals[1]).toBe(99);
    expect(cell.get()).toBe(99);
  });

  it("close captures current value and detaches from frame", () => {
    const frame = { locals: [10, 20, 30] };
    const cell = new UpvalueCell(frame, 2);
    cell.close();
    expect(cell.closed).toBe(true);
    expect(cell.get()).toBe(30);
    frame.locals[2] = 999;
    expect(cell.get()).toBe(30);
  });

  it("set after close writes to closedValue, not frame", () => {
    const frame = { locals: [10, 20] };
    const cell = new UpvalueCell(frame, 0);
    cell.close();
    cell.set(42);
    expect(cell.get()).toBe(42);
    expect(frame.locals[0]).toBe(10);
  });

  it("close is idempotent", () => {
    const frame = { locals: [10] };
    const cell = new UpvalueCell(frame, 0);
    cell.close();
    cell.set(99);
    cell.close();
    expect(cell.get()).toBe(99);
  });

  it("two cells sharing same frame slot see each other's writes when open", () => {
    const frame = { locals: [10] };
    const cell1 = new UpvalueCell(frame, 0);
    const cell2 = new UpvalueCell(frame, 0);
    cell1.set(42);
    expect(cell2.get()).toBe(42);
  });

  it("closing one cell doesn't affect another on same slot", () => {
    const frame = { locals: [10] };
    const cell1 = new UpvalueCell(frame, 0);
    const cell2 = new UpvalueCell(frame, 0);
    cell1.close();
    cell2.set(77);
    expect(cell1.get()).toBe(10);
    expect(cell2.get()).toBe(77);
  });
});

describe("Environment", () => {
  it("getUpvalue and setUpvalue delegate to cells", () => {
    const frame = { locals: [100, 200] };
    const cells = [new UpvalueCell(frame, 0), new UpvalueCell(frame, 1)];
    const env = new Environment(cells);
    expect(env.getUpvalue(0)).toBe(100);
    expect(env.getUpvalue(1)).toBe(200);
    env.setUpvalue(0, 999);
    expect(env.getUpvalue(0)).toBe(999);
    expect(frame.locals[0]).toBe(999);
  });

  it("works with closed cells", () => {
    const frame = { locals: [5, 10] };
    const cell0 = new UpvalueCell(frame, 0);
    const cell1 = new UpvalueCell(frame, 1);
    cell0.close();
    const env = new Environment([cell0, cell1]);
    env.setUpvalue(1, 77);
    expect(env.getUpvalue(0)).toBe(5);
    expect(env.getUpvalue(1)).toBe(77);
    env.setUpvalue(0, 42);
    expect(env.getUpvalue(0)).toBe(42);
    expect(frame.locals[0]).toBe(5);
  });
});

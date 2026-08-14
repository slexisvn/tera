import { describe, expect, it } from "vitest";
import {
  buildClassTable,
  referenceFieldOffsets,
  CLASS_HEADER_BYTES,
} from "../../../src/optimizing/metadata/class-table.js";
import {
  coroutineBaseShapes,
  coroutineFrameName,
  coroutineFrameShape,
  coroutinePromiseName,
  coroutinePromiseShape,
  CORO_FRAME_BASE,
  CORO_NEXT_FIELD,
  CORO_NEXT_REJECTED_FIELD,
  CORO_PROMISE_BASE,
  CORO_RESULT_FIELD,
  CORO_ROUTINE_FIELD,
  CORO_STATE_FIELD,
  CORO_VALUE_FIELD,
  CORO_WAITER_FIELD,
} from "../../../src/optimizing/metadata/coroutines.js";
import {
  SCALAR_TEXT,
  TEXT_STORAGE_BYTES,
} from "../../../src/optimizing/types/scalar.js";

function table() {
  const classes = buildClassTable([]);
  coroutineBaseShapes(classes);
  return classes;
}

describe("coroutine shapes", () => {
  it("gives every frame the same header so the queue can walk any of them", () => {
    const classes = table();
    coroutinePromiseShape(classes, "f", "int");
    const frame = coroutineFrameShape(classes, "f", [{ name: "slot0", declaredType: "int" }]);
    const base = classes.shapeOf(CORO_FRAME_BASE)!;

    for (const name of [CORO_ROUTINE_FIELD, CORO_STATE_FIELD, CORO_NEXT_FIELD]) {
      expect([name, frame.fields.get(name)!.offset]).toEqual([
        name,
        base.fields.get(name)!.offset,
      ]);
    }
  });

  it("traces the queue link and the promise a frame is holding", () => {
    const classes = table();
    coroutinePromiseShape(classes, "f", "int");
    const frame = coroutineFrameShape(classes, "f", []);

    expect(referenceFieldOffsets(frame)).toEqual([
      frame.fields.get(CORO_NEXT_FIELD)!.offset,
      frame.fields.get(CORO_RESULT_FIELD)!.offset,
    ]);
  });

  it("traces the parked waiter and the rejected link but not a scalar result", () => {
    const classes = table();
    const promise = coroutinePromiseShape(classes, "f", "int");

    expect(referenceFieldOffsets(promise)).toEqual([
      promise.fields.get(CORO_WAITER_FIELD)!.offset,
      promise.fields.get(CORO_NEXT_REJECTED_FIELD)!.offset,
    ]);
    expect(promise.fields.get(CORO_VALUE_FIELD)!.declaredType).toBe("int");
  });

  it("keeps a rejection the collector can still reach on the unreported list", () => {
    const classes = table();
    const promise = coroutinePromiseShape(classes, "f", "int");
    const link = promise.fields.get(CORO_NEXT_REJECTED_FIELD)!;

    expect([link.declaredType, referenceFieldOffsets(promise).includes(link.offset)]).toEqual([
      CORO_PROMISE_BASE,
      true,
    ]);
  });

  it("gives a string result storage of its own that the collector never follows", () => {
    const classes = table();
    const promise = coroutinePromiseShape(classes, "f", "string");
    const value = promise.fields.get(CORO_VALUE_FIELD)!;

    expect(value.scalar).toBe(SCALAR_TEXT);
    expect(promise.size).toBeGreaterThanOrEqual(value.offset + TEXT_STORAGE_BYTES);
    expect(referenceFieldOffsets(promise)).toEqual([
      promise.fields.get(CORO_WAITER_FIELD)!.offset,
      promise.fields.get(CORO_NEXT_REJECTED_FIELD)!.offset,
    ]);
  });

  it("gives a string slot storage of its own without moving the slots after it", () => {
    const classes = table();
    coroutinePromiseShape(classes, "f", "int");
    const frame = coroutineFrameShape(classes, "f", [
      { name: "slot0", declaredType: "string" },
      { name: "slot1", declaredType: "int" },
    ]);
    const text = frame.fields.get("slot0")!;
    const after = frame.fields.get("slot1")!;

    expect(text.scalar).toBe(SCALAR_TEXT);
    expect(after.offset).toBeGreaterThanOrEqual(text.offset + TEXT_STORAGE_BYTES);
    expect(referenceFieldOffsets(frame)).not.toContain(text.offset);
  });

  it("keeps a reference-valued result in the traced set alongside the waiter", () => {
    const classes = table();
    coroutinePromiseShape(classes, "g", "int");
    const promise = coroutinePromiseShape(classes, "f", coroutinePromiseName("g"));

    expect(referenceFieldOffsets(promise)).toEqual([
      promise.fields.get(CORO_WAITER_FIELD)!.offset,
      promise.fields.get(CORO_NEXT_REJECTED_FIELD)!.offset,
      promise.fields.get(CORO_VALUE_FIELD)!.offset,
    ]);
  });

  it("reaches a parked frame through the promise it is waiting on", () => {
    const classes = table();
    const promise = coroutinePromiseShape(classes, "f", "int");
    const waiter = promise.fields.get(CORO_WAITER_FIELD)!;

    expect([waiter.declaredType, referenceFieldOffsets(promise).includes(waiter.offset)]).toEqual([
      CORO_FRAME_BASE,
      true,
    ]);
  });

  it("lays every synthetic shape out after the object header", () => {
    const classes = table();
    coroutinePromiseShape(classes, "f", "int");
    const frame = coroutineFrameShape(classes, "f", []);

    for (const declared of frame.fields.values()) {
      expect([declared.name, declared.offset]).toEqual([
        declared.name,
        expect.any(Number) as unknown as number,
      ]);
      expect(declared.offset).toBeGreaterThanOrEqual(CLASS_HEADER_BYTES);
    }
    expect(classes.shapeOf(coroutineFrameName("f"))).toBe(frame);
    expect(classes.shapeOf(CORO_PROMISE_BASE)).not.toBeNull();
  });

  it("gives each synthetic shape a distinct id the class table can emit", () => {
    const classes = table();
    coroutinePromiseShape(classes, "f", "int");
    coroutineFrameShape(classes, "f", []);
    const ids = classes.shapes().map((shape) => shape.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
  });
});

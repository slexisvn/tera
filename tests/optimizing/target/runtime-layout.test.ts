import { describe, expect, it } from "vitest";
import { heapData, heapImageOf } from "../../../src/optimizing/machine/heap-data.js";
import { machineDataSize } from "../../../src/optimizing/machine/data.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import { objectType, smiType } from "../../../src/optimizing/types/lattice.js";
import { C_HEAP_SUPPORT, cClassTable } from "../../../src/optimizing/backends/c/emit.js";
import {
  TERA_ARRAYS,
  TERA_CLASS_RECORD,
  TERA_CONTEXT,
  TERA_RECORDS,
  TERA_STATIC_ROOT_COUNT,
  TERA_STATIC_ROOTS,
  TERA_TABLES,
} from "../../../src/optimizing/target/runtime-layout.js";

const emitted = new Map(
  heapData(heapImageOf(null, undefined)).map((datum) => [datum.label, datum]),
);

function cFieldName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

describe("runtime layout", () => {
  it("gives every record field a naturally aligned, non-overlapping slot", () => {
    for (const record of TERA_RECORDS) {
      let reach = 0;
      for (const field of record.fields) {
        expect([record.symbol, field.name, field.offset % field.bytes]).toEqual([
          record.symbol,
          field.name,
          0,
        ]);
        expect(field.offset).toBeGreaterThanOrEqual(reach);
        reach = field.offset + field.size;
      }
      expect(record.bytes).toBeGreaterThanOrEqual(reach);
    }
  });

  it("emits one datum per declared record, array and table", () => {
    const declared = [
      ...TERA_RECORDS.map((record) => record.symbol),
      ...TERA_ARRAYS.map((array) => array.symbol),
      ...TERA_TABLES.map((table) => table.symbol),
    ];
    expect([...emitted.keys()].sort()).toEqual([...new Set(declared)].sort());
  });

  it("reserves exactly the declared number of bytes for the context", () => {
    const datum = emitted.get(TERA_CONTEXT.symbol)!;
    expect(machineDataSize(datum.items)).toBe(TERA_CONTEXT.bytes);
    expect(datum.alignment).toBe(TERA_CONTEXT.alignment);
    expect(datum.writable).toBe(true);
  });

  it("reserves exactly the declared number of bytes for every array", () => {
    for (const array of TERA_ARRAYS) {
      const datum = emitted.get(array.symbol)!;
      expect([array.symbol, machineDataSize(datum.items)]).toEqual([array.symbol, array.size]);
      expect([array.symbol, datum.alignment]).toEqual([array.symbol, array.alignment]);
    }
  });

  it("lays each class record out at the declared stride and field offsets", () => {
    const classes = buildClassTable([
      {
        name: "Pair",
        parent: null,
        abstract: false,
        constructorParams: [],
        constructorParamNames: [],
        members: [
          { name: "left", owner: "Pair", member: "field", declaredType: "int", static: false, abstract: false },
          { name: "right", owner: "Pair", member: "field", declaredType: "int", static: false, abstract: false },
        ],
      },
    ] as never);
    const records = new Map(
      heapData(heapImageOf(classes, undefined)).map((datum) => [datum.label, datum]),
    );
    const items = records.get(TERA_CLASS_RECORD.symbol)!.items;

    expect(machineDataSize(items)).toBe(TERA_CLASS_RECORD.bytes * 2);
    expect(items.length).toBe(TERA_CLASS_RECORD.fields.length * 2);

    const perRecord = TERA_CLASS_RECORD.fields.length;
    TERA_CLASS_RECORD.fields.forEach((field, index) => {
      expect([field.name, items[index]!.kind === "integer" && (items[index] as { size: number }).size]).toEqual([
        field.name,
        field.bytes,
      ]);
    });
    const tail = items[perRecord + TERA_CLASS_RECORD.fields.findIndex((f) => f.name === "tailReferences")]!;
    expect(tail).toEqual({ kind: "integer", value: 0n, size: 4 });
  });

  it("marks only a buffer of references as carrying a tail the collector walks", () => {
    const classes = buildClassTable([
      {
        name: "Node",
        parent: null,
        abstract: false,
        constructorParams: [],
        constructorParamNames: [],
        members: [],
      },
    ] as never);
    const references = classes.arrayLayoutOf(
      classes.defineArray(objectType(classes.shapeIdOf("Node")!))!,
    )!;
    const numbers = classes.arrayLayoutOf(classes.defineArray(smiType())!)!;

    expect(references.buffer.tailReferences).toBe(true);
    expect(numbers.buffer.tailReferences).toBe(false);

    const items = new Map(
      heapData(heapImageOf(classes, undefined)).map((datum) => [datum.label, datum]),
    ).get(TERA_CLASS_RECORD.symbol)!.items;
    const tailAt = (shape: number): unknown =>
      items[
        shape * TERA_CLASS_RECORD.fields.length +
          TERA_CLASS_RECORD.fields.findIndex((field) => field.name === "tailReferences")
      ];

    expect(tailAt(references.buffer.id)).toEqual({ kind: "integer", value: 1n, size: 4 });
    expect(tailAt(numbers.buffer.id)).toEqual({ kind: "integer", value: 0n, size: 4 });
  });

  it("declares the same context fields in the C backend, in the same order", () => {
    const struct = C_HEAP_SUPPORT.slice(0, C_HEAP_SUPPORT.indexOf("} tera_context_t;"));
    const declared = TERA_CONTEXT.fields.map((field) => cFieldName(field.name));
    const found = [...struct.matchAll(/\b(\w+);/g)].map((match) => match[1]!);
    expect(found).toEqual(declared);
  });

  it("sizes the C backend storage from the same declarations", () => {
    for (const array of TERA_ARRAYS) {
      expect([array.symbol, C_HEAP_SUPPORT.includes(`${array.symbol}[${array.capacity}]`)]).toEqual([
        array.symbol,
        true,
      ]);
    }
  });

  it("names the same class tables in the C backend", () => {
    const source = cClassTable(null);
    for (const symbol of [TERA_CLASS_RECORD.symbol, TERA_STATIC_ROOTS.symbol, TERA_STATIC_ROOT_COUNT.symbol]) {
      expect([symbol, source.includes(symbol)]).toEqual([symbol, true]);
    }
  });
});

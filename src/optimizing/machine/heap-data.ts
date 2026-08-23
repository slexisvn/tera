import { referenceFieldOffsets, type ClassTable } from "../metadata/class-table.js";
import { SCALAR_POINTER } from "../types/scalar.js";
import {
  TERA_ARRAYS,
  TERA_CLASS_FIELDS,
  TERA_CLASS_RECORD,
  TERA_CONTEXT,
  TERA_COUNT_BYTES,
  TERA_HEAP_RESERVE_BYTES,
  TERA_STATIC_ROOT_COUNT,
  TERA_STATIC_ROOTS,
  requireContextStorage,
  type RuntimeArray,
  type RuntimeTable,
} from "../target/runtime-layout.js";
import { integerData, zeroData, zeroFilledBuffer, type MachineDataItem } from "./data.js";
import type { MachineDatum } from "./ir.js";

interface ClassData {
  readonly records: readonly MachineDataItem[];
  readonly fields: readonly MachineDataItem[];
  readonly statics: readonly MachineDataItem[];
  readonly staticCount: number;
}

function reserved(label: string, bytes: number, alignment: number): MachineDatum {
  return { label, alignment, items: zeroFilledBuffer(bytes), writable: true };
}

function storage(array: RuntimeArray): MachineDatum {
  return reserved(array.symbol, array.size, array.alignment);
}

function table(
  declaration: RuntimeTable,
  items: readonly MachineDataItem[],
): MachineDatum {
  return { label: declaration.symbol, alignment: declaration.alignment, items, writable: false };
}

function padded(items: readonly MachineDataItem[]): readonly MachineDataItem[] {
  return items.length > 0 ? items : [integerData(0, TERA_COUNT_BYTES)];
}

function classData(classes: ClassTable | null): ClassData {
  const records: MachineDataItem[] = [];
  const fields: MachineDataItem[] = [];
  const statics: MachineDataItem[] = [];
  const record = (tail: boolean, start: number, count: number): void => {
    const values = new Map<string, number>([
      ["tailReferences", tail ? 1 : 0],
      ["fieldStart", start],
      ["fieldCount", count],
      ["reserved", 0],
    ]);
    for (const field of TERA_CLASS_RECORD.fields) {
      records.push(integerData(values.get(field.name)!, field.bytes));
    }
  };

  record(false, 0, 0);
  for (const shape of classes === null ? [] : classes.shapes()) {
    const offsets = referenceFieldOffsets(shape);
    record(shape.tailReferences, fields.length, offsets.length);
    for (const offset of offsets) fields.push(integerData(offset, TERA_CLASS_FIELDS.bytes));
    for (const field of shape.staticFields.values()) {
      if (field.scalar === SCALAR_POINTER) {
        statics.push(integerData(field.offset, TERA_STATIC_ROOTS.bytes));
      }
    }
  }
  for (const variable of classes === null ? [] : classes.globals()) {
    if (variable.scalar === SCALAR_POINTER) {
      statics.push(integerData(variable.offset, TERA_STATIC_ROOTS.bytes));
    }
  }
  return {
    records,
    fields: padded(fields),
    statics: padded(statics),
    staticCount: statics.length,
  };
}

function contextDatum(reserveBytes: number): MachineDatum {
  requireContextStorage();
  const field = TERA_CONTEXT.field("arenaReserved");
  const trailing = TERA_CONTEXT.bytes - field.offset - field.size;
  return {
    label: TERA_CONTEXT.symbol,
    alignment: TERA_CONTEXT.alignment,
    writable: true,
    items: [
      ...(field.offset > 0 ? [zeroData(field.offset)] : []),
      integerData(reserveBytes, field.bytes),
      ...(trailing > 0 ? [zeroData(trailing)] : []),
    ],
  };
}

export interface HeapImage {
  readonly classes: ClassTable | null;
  readonly reserveBytes: number;
}

export function heapImageOf(
  classes: ClassTable | null,
  reserveBytes: number | undefined,
): HeapImage {
  return { classes, reserveBytes: reserveBytes ?? TERA_HEAP_RESERVE_BYTES };
}

export function heapData(heap: HeapImage): readonly MachineDatum[] {
  const { records, fields, statics, staticCount } = classData(heap.classes);
  return [
    contextDatum(heap.reserveBytes),
    ...TERA_ARRAYS.map(storage),
    table(TERA_CLASS_RECORD, records),
    table(TERA_CLASS_FIELDS, fields),
    table(TERA_STATIC_ROOTS, statics),
    table(TERA_STATIC_ROOT_COUNT, [
      integerData(staticCount, TERA_STATIC_ROOT_COUNT.bytes),
    ]),
  ];
}

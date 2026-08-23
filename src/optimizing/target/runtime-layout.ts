const POINTER_BYTES = 8;
const COUNT_BYTES = 4;

export type RuntimeOwnership = "shared" | "perThread";

export type RuntimeStorage = "processGlobal" | "perThread";

export interface RuntimeField<Name extends string = string> {
  readonly name: Name;
  readonly bytes: number;
  readonly count: number;
  readonly offset: number;
  readonly size: number;
  readonly ownership: RuntimeOwnership;
}

export interface RuntimeRecord<Name extends string = string> {
  readonly symbol: string;
  readonly bytes: number;
  readonly alignment: number;
  readonly fields: readonly RuntimeField<Name>[];
  field(name: Name): RuntimeField<Name>;
  offsetOf(name: Name): number;
  widthOf(name: Name): number;
}

export interface RuntimeArray {
  readonly symbol: string;
  readonly bytes: number;
  readonly capacity: number;
  readonly size: number;
  readonly alignment: number;
}

export interface RuntimeTable {
  readonly symbol: string;
  readonly bytes: number;
  readonly alignment: number;
}

interface FieldSpec<Name extends string> {
  readonly name: Name;
  readonly bytes: number;
  readonly count?: number;
  readonly ownership?: RuntimeOwnership;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function declareRecord<const Name extends string>(
  symbol: string,
  specs: readonly FieldSpec<Name>[],
): RuntimeRecord<Name> {
  const fields: RuntimeField<Name>[] = [];
  const byName = new Map<Name, RuntimeField<Name>>();
  let cursor = 0;
  let alignment = 1;
  for (const spec of specs) {
    const count = spec.count ?? 1;
    const offset = alignUp(cursor, spec.bytes);
    const field: RuntimeField<Name> = {
      name: spec.name,
      bytes: spec.bytes,
      count,
      offset,
      size: spec.bytes * count,
      ownership: spec.ownership ?? "shared",
    };
    if (byName.has(spec.name)) throw new Error(`${symbol} declares ${spec.name} twice`);
    byName.set(spec.name, field);
    fields.push(field);
    cursor = offset + field.size;
    alignment = Math.max(alignment, spec.bytes);
  }
  const field = (name: Name): RuntimeField<Name> => {
    const found = byName.get(name);
    if (found === undefined) throw new Error(`${symbol} has no field ${name}`);
    return found;
  };
  return {
    symbol,
    bytes: alignUp(cursor, alignment),
    alignment,
    fields,
    field,
    offsetOf: (name) => field(name).offset,
    widthOf: (name) => field(name).bytes,
  };
}

function declareArray(
  symbol: string,
  bytes: number,
  capacity: number,
  alignment = bytes,
): RuntimeArray {
  return { symbol, bytes, capacity, size: bytes * capacity, alignment };
}

function declareTable(symbol: string, bytes: number, alignment = bytes): RuntimeTable {
  return { symbol, bytes, alignment };
}

export const TERA_ROOT_CAPACITY = 1 << 14;
export const TERA_MARK_CAPACITY = 1 << 12;
export const TERA_YOUNG_CAPACITY = 1 << 13;
export const TERA_REMEMBERED_CAPACITY = 1 << 11;
export const TERA_STATICS_BYTES = 1 << 12;

export const TERA_HEAP_RESERVE_BYTES = 1 << 30;
export const TERA_HEAP_COMMIT_BYTES = 1 << 20;
export const TERA_HEAP_MINIMUM_BYTES = 1 << 16;


const OWNED: RuntimeOwnership = "perThread";

export const TERA_CONTEXT = declareRecord("tera_context", [
  { name: "arenaBase", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "arenaCursor", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "arenaCommitted", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "arenaReserved", bytes: POINTER_BYTES },
  { name: "freeHead", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "rootsBase", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "rootCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "marksBase", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "nurseryLimit", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "youngBase", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "youngCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "rememberedBase", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "rememberedCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "waitHead", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "waitTail", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "waitCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "waitDue", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "sweepHead", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "sweepCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "queueHead", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "queueTail", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "queueCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "rejectedHead", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "rejectedCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "rejectedText", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "reportedCount", bytes: POINTER_BYTES, ownership: OWNED },
  { name: "pendingThrowFlag", bytes: COUNT_BYTES, ownership: OWNED },
  { name: "pendingThrowValue", bytes: POINTER_BYTES, ownership: OWNED },
]);

export type TeraContextField = (typeof TERA_CONTEXT.fields)[number]["name"];

export const TERA_CONTEXT_STORAGE: RuntimeStorage = "processGlobal";

export const TERA_THREAD_ENTRY_POINTS: readonly string[] = [
  "CreateThread",
  "CreateRemoteThread",
  "_beginthread",
  "_beginthreadex",
  "pthread_create",
  "thrd_create",
  "clone",
  "clone3",
  "bsdthread_create",
];

export function perThreadContextFields(): readonly TeraContextField[] {
  return TERA_CONTEXT.fields
    .filter((entry) => entry.ownership === "perThread")
    .map((entry) => entry.name);
}

function unprovisioned(): string {
  return `${perThreadContextFields().join(", ")} in one ${TERA_CONTEXT.symbol}`;
}

export function contextStorageFault(storage: RuntimeStorage): string | null {
  if (storage === "processGlobal") return null;
  return `${TERA_CONTEXT.symbol} cannot be ${storage} storage while a program keeps ${unprovisioned()}: ${TERA_ARRAYS.map((array) => array.symbol).join(" and ")} and the arena itself are one instance each, so a second thread would share them`;
}

export function requireContextStorage(): RuntimeStorage {
  const fault = contextStorageFault(TERA_CONTEXT_STORAGE);
  if (fault !== null) throw new Error(fault);
  return TERA_CONTEXT_STORAGE;
}

export function threadEntryPointFault(surface: Iterable<string>): string | null {
  const offered = [...surface].filter((name) => TERA_THREAD_ENTRY_POINTS.includes(name));
  if (offered.length === 0) return null;
  return `${offered.join(", ")} would run tera code on a second thread while a program keeps ${unprovisioned()}`;
}

export function withoutThreadEntryPoints<Surface extends Iterable<string>>(
  surface: Surface,
): Surface {
  const fault = threadEntryPointFault(surface);
  if (fault !== null) throw new Error(fault);
  return surface;
}

export const TERA_CLASS_RECORD = declareRecord("tera_classes", [
  { name: "tailReferences", bytes: COUNT_BYTES },
  { name: "fieldStart", bytes: COUNT_BYTES },
  { name: "fieldCount", bytes: COUNT_BYTES },
  { name: "reserved", bytes: COUNT_BYTES },
]);

export const TERA_ROOTS = declareArray("tera_roots", POINTER_BYTES, TERA_ROOT_CAPACITY);
export const TERA_MARKS = declareArray("tera_marks", POINTER_BYTES, TERA_MARK_CAPACITY);
export const TERA_YOUNG = declareArray("tera_young", POINTER_BYTES, TERA_YOUNG_CAPACITY);
export const TERA_REMEMBERED = declareArray(
  "tera_remembered",
  POINTER_BYTES,
  TERA_REMEMBERED_CAPACITY,
);
export const TERA_STATICS = declareArray("tera_statics", 1, TERA_STATICS_BYTES, POINTER_BYTES);

export const TERA_CLASS_FIELDS = declareTable("tera_class_fields", COUNT_BYTES);
export const TERA_STATIC_ROOTS = declareTable("tera_static_roots", COUNT_BYTES);
export const TERA_STATIC_ROOT_COUNT = declareTable("tera_static_root_count", COUNT_BYTES);

export const TERA_RECORDS: readonly RuntimeRecord[] = [TERA_CONTEXT, TERA_CLASS_RECORD];

export const TERA_ARRAYS: readonly RuntimeArray[] = [
  TERA_ROOTS,
  TERA_MARKS,
  TERA_YOUNG,
  TERA_REMEMBERED,
  TERA_STATICS,
];

export const TERA_TABLES: readonly RuntimeTable[] = [
  TERA_CLASS_FIELDS,
  TERA_STATIC_ROOTS,
  TERA_STATIC_ROOT_COUNT,
];

export const TERA_ALLOC_SYMBOL = "tera_alloc";
export const TERA_ARRAY_RESERVE_SYMBOL = "tera_array_reserve";
export const TERA_COLLECT_SYMBOL = "tera_collect";
export const TERA_MINOR_SYMBOL = "tera_minor";
export const TERA_BARRIER_SYMBOL = "tera_write_barrier";
export const TERA_ENTER_ROOTS_SYMBOL = "tera_enter_roots";
export const TERA_RESERVE_SYMBOL = "tera_reserve";
export const TERA_GROW_SYMBOL = "tera_grow";

export const TERA_ROOT_ENTRY_BYTES = TERA_ROOTS.bytes;
export const TERA_ROOT_SLOT_SHIFT = Math.log2(TERA_ROOTS.bytes);
export const TERA_CLASS_RECORD_SHIFT = Math.log2(TERA_CLASS_RECORD.bytes);
export const TERA_COUNT_SHIFT = Math.log2(COUNT_BYTES);

export const TERA_FREE_SHAPE_ID = 0;
export const TERA_MARK_FLAG = 1;
export const TERA_OLD_FLAG = 2;
export const TERA_REMEMBERED_FLAG = 4;
export const TERA_BLOCK_FLAGS = TERA_MARK_FLAG | TERA_OLD_FLAG | TERA_REMEMBERED_FLAG;
export const TERA_LINK_BYTES = POINTER_BYTES;

export { POINTER_BYTES as TERA_POINTER_BYTES, COUNT_BYTES as TERA_COUNT_BYTES };

import {
  strictEqual,
  getHeapId,
  getPayload,
  getTag,
  isObject,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

const INITIAL_BUCKET_COUNT = 4;
const LOAD_FACTOR = 0.75;
const EMPTY = -1;
const DELETED = -2;

type SymbolPayload = {
  id: number;
};

type ProbeResult = {
  idx: number;
  found: boolean;
};

function sameValueZero(a: TaggedValue, b: TaggedValue): boolean {
  const ta = getTag(a);
  const tb = getTag(b);
  const aNum = ta === "smi" || ta === "double";
  const bNum = tb === "smi" || tb === "double";
  if (aNum && bNum) {
    const va = getPayload(a);
    const vb = getPayload(b);
    if (Number.isNaN(va) && Number.isNaN(vb)) return true;
    return va === vb;
  }
  return strictEqual(a, b);
}

function hashTaggedValue(key: TaggedValue): number {
  const tag = getTag(key);
  switch (tag) {
    case "smi":
      return hashInteger(getPayload(key) as number);
    case "double": {
      const v = getPayload(key) as number;
      if (Number.isNaN(v)) return 0x7FC00000;
      return hashDouble(v);
    }
    case "string":
      return hashString(getPayload(key) as string);
    case "bool":
      return getPayload(key) ? 1 : 0;
    case "null":
      return 0x4E554C4C;
    case "undefined":
      return 0x554E4445;
    case "symbol":
      return hashInteger(((getPayload(key) as SymbolPayload).id ^ 0x5359) | 0);
    default:
      return hashInteger(key);
  }
}

function hashInteger(n: number): number {
  n = ((n >>> 16) ^ n) * 0x45d9f3b | 0;
  n = ((n >>> 16) ^ n) * 0x45d9f3b | 0;
  n = (n >>> 16) ^ n;
  return n >>> 0;
}

function hashDouble(v: number): number {
  if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) {
    return hashInteger(v | 0);
  }
  const buf = new Float64Array(1);
  buf[0] = v;
  const view = new Uint32Array(buf.buffer);
  return hashInteger((view[0]! ^ view[1]!) | 0);
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export class OrderedHashMap {
  _bucketCount: number;
  _buckets: Int32Array;
  _keys: TaggedValue[];
  _values: TaggedValue[];
  _chains: number[];
  _deleted: boolean[];
  size: number;
  _nDeleted: number;

  constructor() {
    this._bucketCount = INITIAL_BUCKET_COUNT;
    this._buckets = new Int32Array(INITIAL_BUCKET_COUNT).fill(EMPTY);
    this._keys = [];
    this._values = [];
    this._chains = [];
    this._deleted = [];
    this.size = 0;
    this._nDeleted = 0;
  }

  _hash(key: TaggedValue): number {
    return hashTaggedValue(key) & (this._bucketCount - 1);
  }

  _findEntry(key: TaggedValue): number {
    const bucket = this._hash(key);
    let idx = this._buckets[bucket]!;
    while (idx !== EMPTY) {
      if (!this._deleted[idx] && sameValueZero(this._keys[idx], key)) return idx;
      idx = this._chains[idx]!;
    }
    return -1;
  }

  _rehash(): void {
    const oldKeys = this._keys;
    const oldValues = this._values;
    const oldDeleted = this._deleted;
    const newCap = this._bucketCount * 2;

    this._bucketCount = newCap;
    this._buckets = new Int32Array(newCap).fill(EMPTY);
    this._keys = [];
    this._values = [];
    this._chains = [];
    this._deleted = [];
    this.size = 0;
    this._nDeleted = 0;

    for (let i = 0; i < oldKeys.length; i++) {
      if (!oldDeleted[i]) this.set(oldKeys[i]!, oldValues[i]!);
    }
  }

  get(key: TaggedValue): TaggedValue | undefined {
    const idx = this._findEntry(key);
    return idx === -1 ? undefined : this._values[idx];
  }

  set(key: TaggedValue, value: TaggedValue): void {
    const idx = this._findEntry(key);
    if (idx !== -1) {
      this._values[idx] = value;
      return;
    }
    if ((this.size + this._nDeleted + 1) > this._bucketCount * LOAD_FACTOR) {
      this._rehash();
    }
    const newIdx = this._keys.length;
    const bucket = this._hash(key);
    this._chains.push(this._buckets[bucket]);
    this._buckets[bucket] = newIdx;
    this._keys.push(key);
    this._values.push(value);
    this._deleted.push(false);
    this.size++;
  }

  has(key: TaggedValue): boolean {
    return this._findEntry(key) !== -1;
  }

  delete(key: TaggedValue): boolean {
    const idx = this._findEntry(key);
    if (idx === -1) return false;
    this._deleted[idx] = true;
    this.size--;
    this._nDeleted++;
    return true;
  }

  clear(): void {
    this._bucketCount = INITIAL_BUCKET_COUNT;
    this._buckets = new Int32Array(INITIAL_BUCKET_COUNT).fill(EMPTY);
    this._keys = [];
    this._values = [];
    this._chains = [];
    this._deleted = [];
    this.size = 0;
    this._nDeleted = 0;
  }

  *iterateEntries(): Generator<[TaggedValue, TaggedValue]> {
    for (let i = 0; i < this._keys.length; i++) {
      if (!this._deleted[i]) yield [this._keys[i]!, this._values[i]!];
    }
  }

  *iterateKeys(): Generator<TaggedValue> {
    for (let i = 0; i < this._keys.length; i++) {
      if (!this._deleted[i]) yield this._keys[i]!;
    }
  }

  *iterateValues(): Generator<TaggedValue> {
    for (let i = 0; i < this._keys.length; i++) {
      if (!this._deleted[i]) yield this._values[i]!;
    }
  }
}

export class OrderedHashSet {
  _bucketCount: number;
  _buckets: Int32Array;
  _keys: TaggedValue[];
  _chains: number[];
  _deleted: boolean[];
  size: number;
  _nDeleted: number;

  constructor() {
    this._bucketCount = INITIAL_BUCKET_COUNT;
    this._buckets = new Int32Array(INITIAL_BUCKET_COUNT).fill(EMPTY);
    this._keys = [];
    this._chains = [];
    this._deleted = [];
    this.size = 0;
    this._nDeleted = 0;
  }

  _hash(key: TaggedValue): number {
    return hashTaggedValue(key) & (this._bucketCount - 1);
  }

  _findEntry(key: TaggedValue): number {
    const bucket = this._hash(key);
    let idx = this._buckets[bucket]!;
    while (idx !== EMPTY) {
      if (!this._deleted[idx] && sameValueZero(this._keys[idx], key)) return idx;
      idx = this._chains[idx]!;
    }
    return -1;
  }

  _rehash(): void {
    const oldKeys = this._keys;
    const oldDeleted = this._deleted;
    const newCap = this._bucketCount * 2;

    this._bucketCount = newCap;
    this._buckets = new Int32Array(newCap).fill(EMPTY);
    this._keys = [];
    this._chains = [];
    this._deleted = [];
    this.size = 0;
    this._nDeleted = 0;

    for (let i = 0; i < oldKeys.length; i++) {
      if (!oldDeleted[i]) this.add(oldKeys[i]!);
    }
  }

  add(value: TaggedValue): void {
    if (this._findEntry(value) !== -1) return;
    if ((this.size + this._nDeleted + 1) > this._bucketCount * LOAD_FACTOR) {
      this._rehash();
    }
    const newIdx = this._keys.length;
    const bucket = this._hash(value);
    this._chains.push(this._buckets[bucket]);
    this._buckets[bucket] = newIdx;
    this._keys.push(value);
    this._deleted.push(false);
    this.size++;
  }

  has(value: TaggedValue): boolean {
    return this._findEntry(value) !== -1;
  }

  delete(value: TaggedValue): boolean {
    const idx = this._findEntry(value);
    if (idx === -1) return false;
    this._deleted[idx] = true;
    this.size--;
    this._nDeleted++;
    return true;
  }

  clear(): void {
    this._bucketCount = INITIAL_BUCKET_COUNT;
    this._buckets = new Int32Array(INITIAL_BUCKET_COUNT).fill(EMPTY);
    this._keys = [];
    this._chains = [];
    this._deleted = [];
    this.size = 0;
    this._nDeleted = 0;
  }

  *iterateValues(): Generator<TaggedValue> {
    for (let i = 0; i < this._keys.length; i++) {
      if (!this._deleted[i]) yield this._keys[i]!;
    }
  }

  *iterateEntries(): Generator<[TaggedValue, TaggedValue]> {
    for (let i = 0; i < this._keys.length; i++) {
      if (!this._deleted[i]) yield [this._keys[i]!, this._keys[i]!];
    }
  }
}

const EPH_INITIAL_CAPACITY = 4;
const EPH_LOAD_FACTOR = 0.7;
const EPH_EMPTY = 0;
const EPH_DELETED = -1;

export class EphemeronHashTable {
  _capacity: number;
  _heapIds: Int32Array;
  _keys: Array<TaggedValue | undefined>;
  _vals: Array<TaggedValue | undefined>;
  _size: number;
  _nDeleted: number;

  constructor() {
    this._capacity = EPH_INITIAL_CAPACITY;
    this._heapIds = new Int32Array(EPH_INITIAL_CAPACITY).fill(EPH_EMPTY);
    this._keys = new Array<TaggedValue | undefined>(EPH_INITIAL_CAPACITY).fill(undefined);
    this._vals = new Array<TaggedValue | undefined>(EPH_INITIAL_CAPACITY).fill(undefined);
    this._size = 0;
    this._nDeleted = 0;
  }

  get size(): number {
    return this._size;
  }

  _probe(id: number): ProbeResult {
    let idx = (id * 0x9E3779B9 >>> 0) & (this._capacity - 1);
    const start = idx;
    while (true) {
      const stored = this._heapIds[idx]!;
      if (stored === EPH_EMPTY) return { idx, found: false };
      if (stored === id) return { idx, found: true };
      if (stored === EPH_DELETED) {
        const tombstone = idx;
        idx = (idx + 1) & (this._capacity - 1);
        while (true) {
          const s2 = this._heapIds[idx]!;
          if (s2 === EPH_EMPTY) return { idx: tombstone, found: false };
          if (s2 === id) return { idx, found: true };
          idx = (idx + 1) & (this._capacity - 1);
          if (idx === start) return { idx: tombstone, found: false };
        }
      }
      idx = (idx + 1) & (this._capacity - 1);
      if (idx === start) return { idx: -1, found: false };
    }
  }

  _rehash(): void {
    const oldIds = this._heapIds;
    const oldKeys = this._keys;
    const oldVals = this._vals;
    const newCap = this._capacity * 2;

    this._capacity = newCap;
    this._heapIds = new Int32Array(newCap).fill(EPH_EMPTY);
    this._keys = new Array<TaggedValue | undefined>(newCap).fill(undefined);
    this._vals = new Array<TaggedValue | undefined>(newCap).fill(undefined);
    this._size = 0;
    this._nDeleted = 0;

    for (let i = 0; i < oldIds.length; i++) {
      if (oldIds[i]! > 0) this.set(oldKeys[i]!, oldVals[i]!);
    }
  }

  get(key: TaggedValue): TaggedValue | undefined {
    if (!isObject(key)) return undefined;
    const id = getHeapId(key);
    if (id <= 0) return undefined;
    const { idx, found } = this._probe(id);
    return found ? this._vals[idx] : undefined;
  }

  set(key: TaggedValue, value: TaggedValue): void {
    if (!isObject(key)) throw new TypeError("Invalid value used as weak map key");
    const id = getHeapId(key);
    if (id <= 0) throw new TypeError("Invalid value used as weak map key");
    if ((this._size + this._nDeleted + 1) > this._capacity * EPH_LOAD_FACTOR) {
      this._rehash();
    }
    const { idx, found } = this._probe(id);
    if (idx === -1) {
      this._rehash();
      return this.set(key, value);
    }
    if (!found) this._size++;
    this._heapIds[idx] = id;
    this._keys[idx] = key;
    this._vals[idx] = value;
  }

  has(key: TaggedValue): boolean {
    if (!isObject(key)) return false;
    const id = getHeapId(key);
    if (id <= 0) return false;
    return this._probe(id).found;
  }

  delete(key: TaggedValue): boolean {
    if (!isObject(key)) return false;
    const id = getHeapId(key);
    if (id <= 0) return false;
    const { idx, found } = this._probe(id);
    if (!found) return false;
    this._heapIds[idx] = EPH_DELETED;
    this._keys[idx] = undefined;
    this._vals[idx] = undefined;
    this._size--;
    this._nDeleted++;
    return true;
  }
}

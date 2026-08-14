export type Endian = "little" | "big";

export class ByteBuffer {
  private storage: Uint8Array;
  private used = 0;

  constructor(capacity = 256) {
    this.storage = new Uint8Array(Math.max(capacity, 1));
  }

  get length(): number {
    return this.used;
  }

  private reserve(extra: number): void {
    const required = this.used + extra;
    if (required <= this.storage.length) return;
    let capacity = this.storage.length;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.storage.subarray(0, this.used));
    this.storage = grown;
  }

  byte(value: number): void {
    this.reserve(1);
    this.storage[this.used++] = value & 0xff;
  }

  bytes(values: ArrayLike<number>): void {
    this.reserve(values.length);
    for (let index = 0; index < values.length; index++) {
      this.storage[this.used + index] = values[index]! & 0xff;
    }
    this.used += values.length;
  }

  fill(count: number, value: number): void {
    this.reserve(count);
    this.storage.fill(value & 0xff, this.used, this.used + count);
    this.used += count;
  }

  integer(value: number | bigint, size: number, endian: Endian = "little"): void {
    this.reserve(size);
    writeInteger(this.storage, this.used, value, size, endian);
    this.used += size;
  }

  align(alignment: number, value = 0): void {
    if (alignment <= 1) return;
    const padding = (alignment - (this.used % alignment)) % alignment;
    this.fill(padding, value);
  }

  toBytes(): Uint8Array {
    return this.storage.slice(0, this.used);
  }
}

export function writeInteger(
  target: Uint8Array | number[],
  offset: number,
  value: number | bigint,
  size: number,
  endian: Endian = "little",
): void {
  let remaining = BigInt.asUintN(size * 8, BigInt(value));
  for (let index = 0; index < size; index++) {
    const position = endian === "little" ? offset + index : offset + size - 1 - index;
    target[position] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

export function fitsSigned(value: number | bigint, bits: number): boolean {
  if (typeof value === "number" && bits <= 32) {
    const limit = 2 ** (bits - 1);
    return value >= -limit && value < limit;
  }
  const limit = 1n << BigInt(bits - 1);
  const wide = BigInt(value);
  return wide >= -limit && wide < limit;
}

export function fitsUnsigned(value: number, bits: number): boolean {
  return value >= 0 && value < 2 ** bits;
}

export function alignUp(value: number, alignment: number): number {
  if (alignment <= 1) return value;
  return Math.ceil(value / alignment) * alignment;
}

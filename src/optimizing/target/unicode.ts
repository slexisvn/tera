import { TEXT_UNIT_BYTES } from "../types/scalar.js";

const BYTE_BITS = 8;

export const TEXT_UNIT_BITS = TEXT_UNIT_BYTES * BYTE_BITS;
export const TEXT_TERMINATOR_UNITS = 1;

export const LINE_FEED = 10;
export const CARRIAGE_RETURN = 13;

export const SURROGATE_BITS = 10;
export const SURROGATE_UNITS = 2;
export const BMP_UNITS = 1;
export const SUPPLEMENTARY_BASE = 2 ** TEXT_UNIT_BITS;
export const SURROGATE_PAYLOAD_MASK = 2 ** SURROGATE_BITS - 1;
export const LEAD_SURROGATE = 0xd800;
export const TRAIL_SURROGATE = LEAD_SURROGATE + 2 ** SURROGATE_BITS;
export const SURROGATE_LIMIT = TRAIL_SURROGATE + 2 ** SURROGATE_BITS;
export const SURROGATE_MASK = SUPPLEMENTARY_BASE - 1 - SURROGATE_PAYLOAD_MASK;

export const UNICODE_LIMIT = SUPPLEMENTARY_BASE + 2 ** (SURROGATE_BITS * SURROGATE_UNITS);

export const UTF8_TAIL_BITS = 6;
export const UTF8_TAIL_MASK = 2 ** UTF8_TAIL_BITS - 1;
export const UTF8_TAIL_MARK = 2 ** (BYTE_BITS - 1);

const UTF8_LEAD_BITS = BYTE_BITS - 1;

export interface Utf8Sequence {
  readonly bytes: number;
  readonly limit: number;
  readonly mark: number;
  readonly leadMask: number;
  readonly leadShift: number;
  readonly tailShifts: readonly number[];
}

function utf8Sequence(bytes: number): Utf8Sequence {
  const leadBits = bytes === 1 ? UTF8_LEAD_BITS : UTF8_LEAD_BITS - bytes;
  const leadShift = UTF8_TAIL_BITS * (bytes - 1);
  return {
    bytes,
    limit: 2 ** (leadBits + leadShift),
    mark: bytes === 1 ? 0 : (2 ** bytes - 1) * 2 ** (BYTE_BITS - bytes),
    leadMask: 2 ** leadBits - 1,
    leadShift,
    tailShifts: Array.from(
      { length: bytes - 1 },
      (_unused, index) => leadShift - UTF8_TAIL_BITS * (index + 1),
    ),
  };
}

function utf8Sequences(): readonly Utf8Sequence[] {
  const sequences: Utf8Sequence[] = [];
  do {
    sequences.push(utf8Sequence(sequences.length + 1));
  } while (sequences[sequences.length - 1]!.limit < UNICODE_LIMIT);
  return sequences;
}

export const UTF8_SEQUENCES: readonly Utf8Sequence[] = utf8Sequences();

export const UTF8_MOST_BYTES = UTF8_SEQUENCES.length;

export const ASCII_LIMIT = UTF8_SEQUENCES[0]!.limit;

export const TEXT_STREAM_BYTES = 1 << 12;
